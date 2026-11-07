"""Word timing with speech recognition (faster-whisper) and lyric alignment.

faster-whisper is an optional dependency (``requirements-words.txt``); it is
imported lazily so the service starts without it.  The model (size from
``VOICECOACH_WHISPER_MODEL``, default ``small``) runs on the CPU with int8
weights and is downloaded from huggingface.co on first use.

Two independent parts:

* :func:`transcribe_words` – runs recognition on mono float audio and returns
  ``WordTiming`` dicts (``{"t0", "t1", "text", "conf"}``, see ``types.ts``).
* :func:`align_lyrics` – pure Python: aligns the user's own lyric text to the
  recognised words with ``difflib`` (keeps the user's spelling, interpolates
  timing for words recognition missed).  No model needed, unit-tested.
"""

from __future__ import annotations

import difflib
import functools
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

log = logging.getLogger("voicecoach.words")

# Download the weights over plain HTTPS from huggingface.co and its CDN rather than the Xet
# storage protocol, which needs extra hosts (cas-server.xethub.hf.co) that firewalls often block.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODEL_SIZE = os.environ.get("VOICECOACH_WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("VOICECOACH_WHISPER_LANGUAGE") or None  # None = auto-detect
CPU_THREADS = int(os.environ.get("VOICECOACH_WHISPER_THREADS", "4"))
WHISPER_SR = 16000
MIN_WORD_S = 0.03      # recognised words shorter than this get a minimal length
MAX_WORD_S = 4.0       # longer "words" are usually a held vowel plus silence; clamp the end


class WordsUnavailable(RuntimeError):
    """faster-whisper is not installed or its model cannot be loaded."""


@functools.lru_cache(maxsize=1)
def is_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except Exception:
        return False
    return True


_model = None
_model_error: Optional[str] = None
_model_lock = threading.Lock()


def _get_model():
    """Load (once) the faster-whisper model; raises WordsUnavailable with a readable reason."""
    global _model, _model_error
    if not is_available():
        raise WordsUnavailable("speech model not available: faster-whisper is not installed "
                               "(pip install -r requirements-words.txt)")
    with _model_lock:
        if _model is not None:
            return _model
        if _model_error is not None:
            raise WordsUnavailable(_model_error)
        try:
            from faster_whisper import WhisperModel

            t0 = time.time()
            _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8",
                                  cpu_threads=max(1, CPU_THREADS))
            log.info("whisper '%s' loaded in %.1fs", MODEL_SIZE, time.time() - t0)
            return _model
        except Exception as e:  # download blocked, bad model name, ...
            _model_error = (f"speech model not available: could not load whisper '{MODEL_SIZE}' "
                            f"(weights download from huggingface.co on first use): "
                            f"{e.__class__.__name__}: {str(e)[:200]}")
            log.warning(_model_error)
            raise WordsUnavailable(_model_error) from e


def model_error() -> Optional[str]:
    """The reason the model could not be loaded, once that has happened (None otherwise)."""
    return _model_error


def _to_16k(y: np.ndarray, sr: int) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    if y.ndim > 1:
        y = y.mean(axis=-1)
    if sr != WHISPER_SR:
        import librosa

        y = librosa.resample(y, orig_sr=sr, target_sr=WHISPER_SR, res_type="soxr_hq")
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 1.0:
        y = y / peak
    return np.ascontiguousarray(y, dtype=np.float32)


def transcribe_words(y: np.ndarray, sr: int, *, language: Optional[str] = LANGUAGE,
                     progress_cb=None) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Recognise the words sung in `y` (mono float audio at `sr` Hz).

    Returns ``(words, info)`` where ``words`` is a list of
    ``{"t0", "t1", "text", "conf"}`` sorted by time and ``info`` holds
    ``language``, ``languageProbability``, ``model`` and ``seconds`` (wall time).
    Raises :class:`WordsUnavailable` when the model cannot be used.
    """
    model = _get_model()
    audio = _to_16k(y, sr)
    duration = audio.size / float(WHISPER_SR)
    t_start = time.time()
    # No speech VAD: Silero's speech detector drops long sung vowels, which cost half the words
    # and put onsets more than a second off on a real a cappella clip; without it the whole lyric
    # comes back with onsets a few hundred ms off (then snapped to note onsets by the caller).
    segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,   # sung lyrics repeat; avoids runaway repetition loops
    )
    words: List[Dict[str, Any]] = []
    for seg in segments:  # generator: recognition happens here
        if progress_cb and duration > 0:
            try:
                progress_cb(min(0.99, float(seg.end) / duration))
            except Exception:
                pass
        if seg.no_speech_prob > 0.9 and seg.avg_logprob < -1.0:
            continue  # almost certainly an instrumental stretch that produced garbage
        for w in seg.words or []:
            text = (w.word or "").strip()
            if not text or not re.search(r"\w", text):
                continue
            t0 = float(w.start)
            t1 = float(w.end)
            if t1 - t0 < MIN_WORD_S:
                t1 = t0 + MIN_WORD_S
            if t1 - t0 > MAX_WORD_S:
                t1 = t0 + MAX_WORD_S
            t0 = round(min(t0, duration), 3)
            t1 = round(min(max(t1, t0 + 0.01), duration + 0.01), 3)
            words.append({"t0": t0, "t1": t1, "text": text,
                          "conf": round(float(min(1.0, max(0.0, w.probability))), 3)})
    words.sort(key=lambda w: w["t0"])
    meta = {
        "language": getattr(info, "language", None),
        "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
        "model": MODEL_SIZE,
        "seconds": round(time.time() - t_start, 1),
    }
    log.info("whisper: %d words in %.1fs (lang %s %.2f, audio %.0fs)", len(words), meta["seconds"],
             meta["language"], meta["languageProbability"], duration)
    return words, meta


SNAP_WINDOW_S = 0.6  # measured on a real a cappella clip: phrase-onset error 310 ms -> 43 ms median


def snap_to_notes(words: Sequence[Dict[str, Any]], notes: Sequence[Dict[str, Any]], *,
                  window: float = SNAP_WINDOW_S) -> List[Dict[str, Any]]:
    """Refine recognised word times with the melody's note boundaries.

    Whisper places word starts a few hundred ms off on held notes; the pYIN note segmentation
    knows where notes begin. Each word start moves to the nearest unused note onset within
    `window` seconds (keeping the words in order), and a word end moves to the nearest note
    end within the window when that keeps the word at least 30 ms long. Words far from any
    note (spoken intros, misfires) are left alone. Pure function; returns new dicts.
    """
    if not words or not notes:
        return [dict(w) for w in words]
    starts = np.array(sorted(float(n["start"]) for n in notes))
    ends = np.array(sorted(float(n["end"]) for n in notes))
    used: set = set()
    out: List[Dict[str, Any]] = []
    prev_t0 = -1.0
    for w in sorted(words, key=lambda w: float(w["t0"])):
        t0, t1 = float(w["t0"]), float(w["t1"])
        dur = max(0.03, t1 - t0)
        order = np.argsort(np.abs(starts - t0))
        for k in order[:4]:
            k = int(k)
            if abs(starts[k] - t0) > window:
                break
            if k in used or starts[k] < prev_t0 + 0.02:
                continue
            used.add(k)
            t0 = float(starts[k])
            break
        t1 = max(t1, t0 + 0.03)
        j = int(np.argmin(np.abs(ends - t1)))
        if abs(ends[j] - t1) <= window and ends[j] >= t0 + 0.03:
            t1 = float(ends[j])
        elif t1 < t0 + 0.03:
            t1 = t0 + dur
        prev_t0 = t0
        nw = dict(w)
        nw["t0"], nw["t1"] = round(t0, 3), round(t1, 3)
        out.append(nw)
    return out


# ---------------------------------------------------------------- lyric alignment (pure Python)

_WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)


def _norm_token(tok: str) -> str:
    """Lower-case letters/digits only: "Don't," -> "dont"."""
    return re.sub(r"[^\w]|_", "", tok.lower())


def tokenize_lyrics(text: str) -> List[str]:
    """Split user lyric text into word tokens, keeping their spelling and punctuation.

    LRC timestamps ("[01:23.45]") and section labels in brackets are dropped.
    """
    text = re.sub(r"\[[^\]]*\]", " ", text or "")
    toks = []
    for raw in text.split():
        if _norm_token(raw):
            toks.append(raw)
    return toks


def _interpolate(span_t0: float, span_t1: float, tokens: Sequence[str]) -> List[Tuple[float, float]]:
    """Spread `tokens` over [span_t0, span_t1] proportionally to their length (min 1 char)."""
    n = len(tokens)
    if n == 0:
        return []
    span_t1 = max(span_t1, span_t0 + 0.05 * n)
    weights = np.array([max(1, len(_norm_token(t))) for t in tokens], dtype=np.float64)
    edges = np.concatenate([[0.0], np.cumsum(weights)]) / weights.sum()
    out = []
    for i in range(n):
        a = span_t0 + (span_t1 - span_t0) * edges[i]
        b = span_t0 + (span_t1 - span_t0) * edges[i + 1]
        out.append((a, b))
    return out


def align_lyrics(lyrics: str, recognised: Sequence[Dict[str, Any]], *,
                 span: Optional[Tuple[float, float]] = None) -> List[Dict[str, Any]]:
    """Align the user's lyric text to recognised word timing.

    * words that match (case/punctuation-insensitive) take the recognised timing and confidence;
    * a replaced run with the same word count is paired one to one (misheard words), confidence
      scaled by string similarity;
    * every other unmatched user word gets timing interpolated between its neighbours'
      anchors (proportional to word length) with ``conf`` 0;
    * `span` = (start, end) seconds used when there is no anchor on one side
      (typically the first and last sung note of the song).

    The result has exactly one entry per user word, in the user's order and spelling.
    """
    user = tokenize_lyrics(lyrics)
    if not user:
        return []
    rec = sorted((w for w in recognised if w.get("text")), key=lambda w: float(w["t0"]))
    a = [_norm_token(t) for t in user]
    b = [_norm_token(w["text"]) for w in rec]
    anchors: List[Optional[Tuple[float, float, float]]] = [None] * len(user)  # (t0, t1, conf)

    if rec:
        sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for k in range(i2 - i1):
                    w = rec[j1 + k]
                    anchors[i1 + k] = (float(w["t0"]), float(w["t1"]), float(w.get("conf", 0.5)))
            elif tag == "replace":
                n_u, n_r = i2 - i1, j2 - j1
                if n_u == n_r:
                    for k in range(n_u):
                        w = rec[j1 + k]
                        sim = difflib.SequenceMatcher(a=a[i1 + k], b=b[j1 + k]).ratio()
                        anchors[i1 + k] = (float(w["t0"]), float(w["t1"]),
                                           round(float(w.get("conf", 0.5)) * sim, 3))
                else:
                    # different word counts: share the recognised span out by word length
                    t0 = float(rec[j1]["t0"])
                    t1 = float(rec[j2 - 1]["t1"])
                    for k, (x, y) in enumerate(_interpolate(t0, t1, user[i1:i2])):
                        anchors[i1 + k] = (x, y, 0.0)

    # interpolate the gaps between anchors
    n = len(user)
    idx_anchor = [i for i in range(n) if anchors[i] is not None]
    if not idx_anchor:
        s0, s1 = span if span else (0.0, max(1.0, 0.4 * n))
        return [{"t0": round(x, 3), "t1": round(y, 3), "text": user[i], "conf": 0.0}
                for i, (x, y) in enumerate(_interpolate(s0, s1, user))]

    mean_dur = float(np.mean([anchors[i][1] - anchors[i][0] for i in idx_anchor]))
    mean_dur = min(1.0, max(0.15, mean_dur))
    first, last = idx_anchor[0], idx_anchor[-1]
    # words before the first anchor
    if first > 0:
        end = anchors[first][0]
        start = span[0] if span and span[0] < end else end - mean_dur * first
        start = max(0.0, min(start, end - 0.05 * first))
        for k, (x, y) in enumerate(_interpolate(start, end, user[:first])):
            anchors[k] = (x, y, 0.0)
    # words after the last anchor
    if last < n - 1:
        start = anchors[last][1]
        count = n - 1 - last
        end = span[1] if span and span[1] > start else start + mean_dur * count
        end = max(end, start + 0.05 * count)
        for k, (x, y) in enumerate(_interpolate(start, end, user[last + 1:])):
            anchors[last + 1 + k] = (x, y, 0.0)
    # gaps between anchors
    i = 0
    while i < n:
        if anchors[i] is None:
            j = i
            while anchors[j] is None:
                j += 1
            start = anchors[i - 1][1]
            end = anchors[j][0]
            if end <= start:  # recognised words overlap or touch: squeeze between them
                end = start + 0.05 * (j - i)
            for k, (x, y) in enumerate(_interpolate(start, end, user[i:j])):
                anchors[i + k] = (x, y, 0.0)
            i = j
        i += 1

    out = []
    prev_t0 = -1.0
    for i, tok in enumerate(user):
        t0, t1, conf = anchors[i]
        t0 = max(t0, prev_t0)  # keep the user's order monotonic
        t1 = max(t1, t0 + 0.01)
        out.append({"t0": round(t0, 3), "t1": round(t1, 3), "text": tok, "conf": round(max(0.0, min(1.0, conf)), 3)})
        prev_t0 = t0
    return out
