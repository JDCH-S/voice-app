"""AI vocal coach on the Anthropic Messages API (optional).

* ``chat(messages, context)`` – one reply for a conversation.
* ``plan(context)`` – a ``WeeklyPlan`` (``types.ts``) produced with structured
  output (a JSON schema the API guarantees) and validated again here.
* ``status()`` / ``save_key()`` – key handling.

Key resolution: ``ANTHROPIC_API_KEY`` in the environment, else the file
``<secrets dir>/anthropic_key`` (``VOICECOACH_SECRETS_DIR``, default
``server/.secrets``, mode 600), else the call is still attempted without a key
(a development proxy may authenticate it); a 401 then becomes a clear
"add your Anthropic API key in Settings" error.

Privacy: message content and context are sent to Anthropic only when the user
uses the coach; nothing of it is logged here (only sizes, timings and errors).
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
import stat
import threading
import time
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field, ValidationError

log = logging.getLogger("voicecoach.coach")

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODEL = "claude-sonnet-5-5"
MODEL = os.environ.get("VOICECOACH_COACH_MODEL") or DEFAULT_MODEL
SECRETS_DIR = os.environ.get("VOICECOACH_SECRETS_DIR") or os.path.join(SERVER_DIR, ".secrets")
KEY_FILE = os.path.join(SECRETS_DIR, "anthropic_key")
REQUEST_TIMEOUT_S = 120.0
MAX_MESSAGES = 30          # most recent conversation turns sent
MAX_MESSAGE_CHARS = 4000
MAX_ATTEMPTS = 30          # most recent attempts kept in the context
MAX_CONTEXT_CHARS = 14000  # hard cap on the serialised context
MAX_LIST_ITEMS = 40        # any other list in the context is cut to its last N items
PROBE_TTL_S = 600.0

NO_KEY_MESSAGE = ("The coach needs an Anthropic API key: add your Anthropic API key in Settings "
                  "(or set ANTHROPIC_API_KEY on the analysis server).")

KNOWN_EXERCISE_IDS = {  # web/src/lib/exercises/library.ts; used when the context lists no exercises
    "breathing", "breath-support", "pitch-match", "scales", "sirens", "lip-trills", "sustain",
    "clear-tone", "range-extension", "register-transitions", "onset-precision", "vibrato", "dynamics",
}
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
ITEM_KINDS = ("exercise", "song", "phrase", "rest", "range-test")


class CoachError(Exception):
    """An error with an HTTP status and a message that is safe to show to the singer."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# ---------------------------------------------------------------- availability and keys

def is_available() -> bool:
    try:
        import anthropic  # noqa: F401
    except Exception:
        return False
    return True


def _read_key_file() -> Optional[str]:
    try:
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
        return key or None
    except OSError:
        return None


def resolve_key() -> Tuple[Optional[str], str]:
    """(key or None, source) with source in 'env' | 'file' | 'none'."""
    env = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if env:
        return env, "env"
    saved = _read_key_file()
    if saved:
        return saved, "file"
    return None, "none"


def _valid_key_shape(key: str) -> bool:
    return 20 <= len(key) <= 400 and re.fullmatch(r"[A-Za-z0-9_\-]+", key) is not None


def save_key(key: str) -> None:
    """Store the key in KEY_FILE (dir 700, file 600). An empty key removes the file."""
    key = (key or "").strip()
    if not key:
        try:
            os.remove(KEY_FILE)
        except FileNotFoundError:
            pass
        _invalidate_probe()
        return
    if not _valid_key_shape(key):
        raise CoachError(400, "That does not look like an Anthropic API key (it starts with sk-ant- and has no spaces).")
    os.makedirs(SECRETS_DIR, exist_ok=True)
    try:
        os.chmod(SECRETS_DIR, stat.S_IRWXU)
    except OSError:
        pass
    tmp = KEY_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(key + "\n")
    os.replace(tmp, KEY_FILE)
    try:
        os.chmod(KEY_FILE, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    _invalidate_probe()


def _client(key: Optional[str]):
    import anthropic

    if key:
        return anthropic.Anthropic(api_key=key, timeout=REQUEST_TIMEOUT_S, max_retries=1)
    # No key anywhere: send the request without credentials (a development proxy may add them).
    return anthropic.Anthropic(
        api_key=None,
        default_headers={"Authorization": anthropic.Omit(), "X-Api-Key": anthropic.Omit()},
        timeout=REQUEST_TIMEOUT_S, max_retries=1,
    )


def _fingerprint(key: Optional[str]) -> str:
    return "" if not key else f"{len(key)}:{key[:7]}:{key[-4:]}"


_probe_lock = threading.Lock()
_probe: Dict[str, Any] = {"fp": None, "at": 0.0, "ok": None, "message": None}


def _invalidate_probe() -> None:
    with _probe_lock:
        _probe.update({"fp": None, "at": 0.0, "ok": None, "message": None})


def _note_result(key: Optional[str], ok: bool, message: Optional[str]) -> None:
    with _probe_lock:
        _probe.update({"fp": _fingerprint(key), "at": time.time(), "ok": ok, "message": message})


def _map_error(e: Exception) -> CoachError:
    import anthropic

    name = e.__class__.__name__
    if isinstance(e, anthropic.AuthenticationError):
        return CoachError(401, NO_KEY_MESSAGE)
    if isinstance(e, anthropic.PermissionDeniedError):
        return CoachError(403, "Anthropic rejected the API key for this request (permission denied). Check the key in Settings.")
    if isinstance(e, anthropic.NotFoundError):
        return CoachError(502, f"The coach model '{MODEL}' was not found. Set VOICECOACH_COACH_MODEL to a valid model id.")
    if isinstance(e, anthropic.RateLimitError):
        return CoachError(429, "The coach is busy right now (rate limit). Try again in a minute.")
    if isinstance(e, anthropic.BadRequestError):
        msg = getattr(e, "message", None) or str(e)
        if "credit" in msg.lower() or "billing" in msg.lower():
            return CoachError(402, "Your Anthropic account has no credit left for the coach.")
        return CoachError(502, f"The coach request was rejected: {msg[:200]}")
    if isinstance(e, anthropic.APIStatusError):
        return CoachError(502, f"Anthropic answered HTTP {e.status_code}. Try again later.")
    if isinstance(e, anthropic.APITimeoutError):
        return CoachError(504, "The coach took too long to answer. Try again.")
    if isinstance(e, anthropic.APIConnectionError):
        return CoachError(503, "Could not reach api.anthropic.com. Check the internet connection of the analysis server.")
    return CoachError(502, f"The coach failed: {name}")


def probe(key: Optional[str], force: bool = False) -> Tuple[bool, Optional[str]]:
    """Check that the model can be reached with this key (GET /v1/models/{id}; no tokens used).

    Cached for PROBE_TTL_S per key. Returns (ok, message).
    """
    fp = _fingerprint(key)
    with _probe_lock:
        fresh = _probe["fp"] == fp and time.time() - _probe["at"] < PROBE_TTL_S and _probe["ok"] is not None
        if fresh and not force:
            return bool(_probe["ok"]), _probe["message"]
    try:
        _client(key).with_options(timeout=20.0, max_retries=0).models.retrieve(MODEL)
        ok, message = True, None
    except Exception as e:
        err = _map_error(e)
        ok, message = False, err.detail
        if err.status_code == 401 and key:
            message = "Anthropic rejected this API key (401). Check it in Settings."
    _note_result(key, ok, message)
    return ok, message


def status(check: bool = True) -> Dict[str, Any]:
    """{available, model, keySource, message?} as the web app's CoachStatus expects."""
    if not is_available():
        return {"available": False, "model": MODEL, "keySource": "none",
                "message": "The anthropic package is not installed on the analysis server (pip install anthropic)."}
    key, source = resolve_key()
    out: Dict[str, Any] = {"available": source != "none", "model": MODEL, "keySource": source}
    if check:
        ok, message = probe(key)
        out["available"] = ok
        if not ok:
            out["message"] = message or NO_KEY_MESSAGE
    elif source == "none":
        out["message"] = NO_KEY_MESSAGE
    return out


# ---------------------------------------------------------------- prompts and context

SYSTEM_PROMPT = """You are the Voice Coach: a warm, honest, professional vocal coach built into a practice app that measures the singer's voice (pitch, timing, note length, slides, vibrato, dynamics, breath, breathiness and strain) on songs and exercises.

How you coach:
- Be concrete and short. Plain words a beginner understands; no jargon without a one-line explanation. Usually 3 to 8 sentences, or a short list. No headings.
- Say what was wrong and exactly how to fix it, then name the one exercise to do (use its exact title from the app, and its id when asked for an id). The app's exercises: breathing (low breathing), breath-support (long hiss), pitch-match (match the note), scales (five-note scales), sirens, lip-trills, sustain (long tones), clear-tone, range-extension (reach higher), register-transitions (chest to head), onset-precision (on the beat), vibrato (vibrato waves), dynamics (soft-loud-soft).
- Vocal health first: never tell anyone to push through pain, hoarseness or a tight throat. Tell them to stop, rest, drink water and see a doctor if it lasts more than two weeks. Limit practice to about 20 minutes of singing before a break.
- Use the numbers in the context explicitly (range in note names, scores, the issues that come up most, days practised). Never invent measurements, scores, songs or history that are not in the context; if something is missing, say you do not have that data and ask for it or tell them how to get it in the app (range test, a few attempts at a phrase).
- Pitch error numbers are in cents (100 cents = one semitone); scores are 0 to 100; "flat" means too low, "sharp" too high.
- Encourage honestly: name what improved when the data shows it; do not flatter.
- Do not give medical diagnoses, and do not talk about things unrelated to singing, voice, music practice or performance confidence; politely bring the conversation back.
"""

PLAN_PROMPT = """Build this singer's practice plan for the coming week as JSON matching the schema.

Rules:
- Exactly seven entries in days, in order Mon..Sun, each with a short focus and 1 to 4 items; put at least one rest day (kind "rest", minutes 0) and keep the daily total near the singer's daily goal (default 10 minutes; never more than 25).
- Every practice day starts with a warm-up exercise item (breathing, lip-trills or sirens).
- Pick items from the context only: exerciseId must be one of the exercise ids listed in the context (or one of the app's standard ids when none are listed), songId must be an id from context.songs, phraseIndex a phrase of that song that needs work (kind "phrase") or null. Use kind "range-test" at most once, only if the last range test is older than three weeks or missing.
- Prioritise the weakest criterion and the most frequent issues in the context, and due reviews if listed.
- Titles are what the singer sees: short, plain words ("Long hiss, 3 × 20 s", "Phrase 4 of Hallelujah slowly").
- summary: two or three sentences explaining the week's goal in plain words, naming the main problem the plan attacks.
- Vocal health first: no more than 25 minutes on any day; add a rest day after a hard day.
"""

WEEKLY_PLAN_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "days": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "day": {"type": "string", "enum": DAYS},
                    "focus": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": list(ITEM_KINDS)},
                                "title": {"type": "string"},
                                "exerciseId": {"type": ["string", "null"]},
                                "songId": {"type": ["string", "null"]},
                                "phraseIndex": {"type": ["integer", "null"]},
                                "minutes": {"type": "integer"},
                            },
                            "required": ["kind", "title", "exerciseId", "songId", "phraseIndex", "minutes"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["day", "focus", "items"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "days"],
    "additionalProperties": False,
}


class PlanItemModel(BaseModel):
    kind: Literal["exercise", "song", "phrase", "rest", "range-test"]
    title: str = Field(min_length=1, max_length=200)
    exerciseId: Optional[str] = None
    songId: Optional[str] = None
    phraseIndex: Optional[int] = None
    minutes: int = Field(ge=0, le=120)


class PlanDayModel(BaseModel):
    day: Literal["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    focus: str = Field(max_length=300)
    items: List[PlanItemModel] = Field(max_length=8)


class PlanModel(BaseModel):
    summary: str = Field(min_length=1, max_length=2000)
    days: List[PlanDayModel] = Field(min_length=1, max_length=7)


def _summarise_attempt(a: Any) -> Any:
    """Keep only the small, useful fields of a PhraseAttempt-like dict."""
    if not isinstance(a, dict):
        return a
    out: Dict[str, Any] = {}
    for k in ("date", "songId", "songTitle", "title", "phraseIndex", "semitones", "tempo", "scores", "score"):
        if k in a:
            out[k] = a[k]
    issues = a.get("issues")
    if isinstance(issues, list):
        kinds = [i.get("kind") if isinstance(i, dict) else i for i in issues]
        kinds = [k for k in kinds if isinstance(k, str)]
        counts: Dict[str, int] = {}
        for k in kinds:
            counts[k] = counts.get(k, 0) + 1
        out["issues"] = dict(sorted(counts.items(), key=lambda kv: -kv[1])[:6])
    tip = a.get("tip")
    if isinstance(tip, dict) and tip.get("title"):
        out["tip"] = tip["title"]
    return out


def _shrink(obj: Any, depth: int = 0) -> Any:
    """Drop raw signal arrays and cut long lists; recurse."""
    if depth > 6:
        return None
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("frames", "melody", "hz", "rmsDb", "blob", "noteResults", "recording"):
                continue
            if k == "attempts" and isinstance(v, list):
                out[k] = [_summarise_attempt(a) for a in v[-MAX_ATTEMPTS:]]
                continue
            out[k] = _shrink(v, depth + 1)
        return out
    if isinstance(obj, list):
        if len(obj) > 200 and all(isinstance(x, (int, float)) for x in obj[:20]):
            return None  # a signal array, not information for a coach
        return [_shrink(x, depth + 1) for x in obj[-MAX_LIST_ITEMS:]]
    if isinstance(obj, str) and len(obj) > 1000:
        return obj[:1000]
    return obj


def compact_context(context: Any) -> Dict[str, Any]:
    """Bound the context: last 30 attempts summarised, no signal arrays, ≤ MAX_CONTEXT_CHARS."""
    if not isinstance(context, dict):
        return {}
    ctx = _shrink(copy.deepcopy(context))
    ctx = {k: v for k, v in ctx.items() if v is not None}
    text = json.dumps(ctx, ensure_ascii=False, separators=(",", ":"))
    # still too big: drop the largest top-level keys (never profile/range/weekStart) until it fits
    protected = {"profile", "range", "weekStart", "level", "goals", "exercises"}
    while len(text) > MAX_CONTEXT_CHARS:
        sizes = {k: len(json.dumps(v, ensure_ascii=False)) for k, v in ctx.items() if k not in protected}
        if not sizes:
            break
        biggest = max(sizes, key=sizes.get)
        v = ctx[biggest]
        if isinstance(v, list) and len(v) > 5:
            ctx[biggest] = v[-(len(v) // 2):]
        else:
            ctx.pop(biggest)
        text = json.dumps(ctx, ensure_ascii=False, separators=(",", ":"))
    return ctx


def context_text(ctx: Dict[str, Any]) -> str:
    if not ctx:
        return "No data about this singer is available yet."
    return json.dumps(ctx, ensure_ascii=False, indent=0)


def _clean_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for m in messages:
        role = m.get("role") if isinstance(m, dict) else None
        content = m.get("content") if isinstance(m, dict) else None
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        content = content.strip()
        if not content:
            continue
        if len(content) > MAX_MESSAGE_CHARS:
            content = content[:MAX_MESSAGE_CHARS]
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n\n" + content  # merge consecutive same-role turns
        else:
            out.append({"role": role, "content": content})
    while out and out[0]["role"] != "user":
        out.pop(0)
    out = out[-MAX_MESSAGES:]
    while out and out[0]["role"] != "user":
        out.pop(0)
    if not out:
        raise CoachError(400, "Ask the coach something first.")
    if out[-1]["role"] != "user":
        out.pop()
        if not out:
            raise CoachError(400, "Ask the coach something first.")
    return out


# ---------------------------------------------------------------- calls

_effort_ok = True  # flipped off if the configured model rejects output_config.effort


def _create(key: Optional[str], effort: str, **kwargs):
    """messages.create with effort when the model accepts it; maps SDK errors to CoachError."""
    global _effort_ok
    import anthropic

    client = _client(key)
    try:
        if _effort_ok:
            cfg = dict(kwargs.pop("output_config", {}) or {})
            cfg["effort"] = effort
            try:
                return client.messages.create(output_config=cfg, **kwargs)
            except anthropic.BadRequestError as e:
                msg = (getattr(e, "message", None) or str(e)).lower()
                if "effort" not in msg:
                    raise
                _effort_ok = False
                log.info("model %s rejects output_config.effort; continuing without it", MODEL)
                cfg.pop("effort", None)
                if cfg:
                    kwargs["output_config"] = cfg
        return client.messages.create(**kwargs)
    except Exception as e:
        err = _map_error(e)
        if err.status_code == 401:
            _note_result(key, False, NO_KEY_MESSAGE)
        raise err from e


def _text_of(response) -> str:
    return "".join(b.text for b in response.content if getattr(b, "type", None) == "text").strip()


def chat(messages: List[Dict[str, Any]], context: Any) -> str:
    """One coach reply. Raises CoachError with an HTTP status on failure."""
    if not is_available():
        raise CoachError(503, "The anthropic package is not installed on the analysis server (pip install anthropic).")
    msgs = _clean_messages(messages)
    ctx = compact_context(context)
    key, source = resolve_key()
    t0 = time.time()
    system = [
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "Data about this singer from the app (JSON):\n" + context_text(ctx)},
    ]
    response = _create(key, "low", model=MODEL, max_tokens=1024, system=system, messages=msgs)
    _note_result(key, True, None)
    if response.stop_reason == "refusal":
        raise CoachError(422, "The coach could not answer that question. Try asking it differently.")
    reply = _text_of(response)
    if not reply:
        raise CoachError(502, "The coach sent an empty answer. Try again.")
    usage = getattr(response, "usage", None)
    log.info("coach chat: %d turns, context %d chars, key=%s, %.1fs, tokens in=%s out=%s",
             len(msgs), len(context_text(ctx)), source, time.time() - t0,
             getattr(usage, "input_tokens", "?"), getattr(usage, "output_tokens", "?"))
    return reply


def _known_ids(ctx: Dict[str, Any]) -> Tuple[set, Dict[str, Optional[int]]]:
    """Exercise ids and song ids (with phrase counts when known) the plan may reference."""
    ex: set = set()
    exercises = ctx.get("exercises")
    if isinstance(exercises, list):
        for e in exercises:
            if isinstance(e, dict) and isinstance(e.get("id"), str):
                ex.add(e["id"])
            elif isinstance(e, str):
                ex.add(e)
    if not ex:
        ex = set(KNOWN_EXERCISE_IDS)
    songs: Dict[str, Optional[int]] = {}
    for s in ctx.get("songs") or []:
        if isinstance(s, dict) and isinstance(s.get("id"), str):
            n = s.get("phrases")
            if isinstance(n, list):
                n = len(n)
            songs[s["id"]] = int(n) if isinstance(n, (int, float)) else None
    return ex, songs


def normalise_plan(raw: Dict[str, Any], ctx: Dict[str, Any], week_start: int) -> Dict[str, Any]:
    """Validate the model's JSON and turn it into a WeeklyPlan (all 7 days, ids that exist)."""
    try:
        model = PlanModel.model_validate(raw)
    except ValidationError as e:
        raise CoachError(502, f"The coach's plan did not match the expected shape: {str(e)[:200]}")
    ex_ids, songs = _known_ids(ctx)
    by_day: Dict[str, Dict[str, Any]] = {}
    for d in model.days:
        if d.day in by_day:
            continue
        items = []
        total = 0
        for it in d.items:
            exercise_id = it.exerciseId if (it.exerciseId in ex_ids) else None
            song_id = it.songId if it.songId in songs else None
            phrase_index = it.phraseIndex
            if song_id is None or phrase_index is None or phrase_index < 0:
                phrase_index = None
            elif songs[song_id] is not None and phrase_index >= songs[song_id]:
                phrase_index = None
            kind = it.kind
            if kind == "exercise" and exercise_id is None and it.title.strip().lower() in ("rest", "rest day"):
                kind = "rest"
            if kind in ("song", "phrase") and song_id is None:
                kind = "exercise" if exercise_id else "rest"
            if kind == "phrase" and phrase_index is None:
                kind = "song"
            minutes = 0 if kind == "rest" else max(1, min(30, it.minutes))
            total += minutes
            items.append({"kind": kind, "title": it.title.strip(), "exerciseId": exercise_id,
                          "songId": song_id, "phraseIndex": phrase_index, "minutes": minutes})
        if total > 25:  # vocal health: scale a too-long day down
            scale = 25.0 / total
            for item in items:
                if item["minutes"]:
                    item["minutes"] = max(1, int(round(item["minutes"] * scale)))
        by_day[d.day] = {"day": d.day, "focus": d.focus.strip(), "items": items}
    days = []
    for name in DAYS:
        days.append(by_day.get(name) or {"day": name, "focus": "Rest",
                                         "items": [{"kind": "rest", "title": "Rest day", "exerciseId": None,
                                                    "songId": None, "phraseIndex": None, "minutes": 0}]})
    return {"weekStart": int(week_start), "summary": model.summary.strip(), "days": days, "source": "coach"}


def _week_start_from(context: Any) -> int:
    ws = context.get("weekStart") if isinstance(context, dict) else None
    if isinstance(ws, (int, float)) and ws > 0:
        return int(ws)
    # Monday 00:00 of the current week (UTC) when the client did not say
    now = time.time()
    lt = time.gmtime(now)
    midnight = now - (lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec)
    return int((midnight - lt.tm_wday * 86400) * 1000)


def plan(context: Any) -> Dict[str, Any]:
    """A WeeklyPlan dict (types.ts) from the coach. Raises CoachError on failure."""
    if not is_available():
        raise CoachError(503, "The anthropic package is not installed on the analysis server (pip install anthropic).")
    ctx = compact_context(context)
    week_start = _week_start_from(context)
    key, source = resolve_key()
    t0 = time.time()
    system = [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
    user = PLAN_PROMPT + "\nData about this singer from the app (JSON):\n" + context_text(ctx)
    response = _create(
        key, "medium", model=MODEL, max_tokens=4096, system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"format": {"type": "json_schema", "schema": WEEKLY_PLAN_SCHEMA}},
    )
    _note_result(key, True, None)
    if response.stop_reason == "refusal":
        raise CoachError(422, "The coach could not build a plan from this data. Try again later.")
    text = _text_of(response)
    try:
        raw = json.loads(text)
    except ValueError:
        raise CoachError(502, "The coach's plan was not valid JSON. Try again.")
    result = normalise_plan(raw, ctx, week_start)
    usage = getattr(response, "usage", None)
    log.info("coach plan: context %d chars, key=%s, %.1fs, tokens in=%s out=%s", len(context_text(ctx)), source,
             time.time() - t0, getattr(usage, "input_tokens", "?"), getattr(usage, "output_tokens", "?"))
    return result
