"""Voice coach analysis service.

Run:  uvicorn main:app --port 8765
See docs/ANALYSIS_SCHEMA.md for the API contract and server/README.md for usage.
"""

from __future__ import annotations

import copy
import logging
import mimetypes
import webbrowser
import os
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from analysis import audio_io, coach, features, lyrics, separate
from analysis import melody as melody_mod
from analysis import words as words_mod

VERSION = "0.2.0"
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
JOBS_ROOT = os.environ.get("VOICE_JOBS_DIR") or os.path.join(SERVER_DIR, ".jobs")
JOB_TTL_S = 2 * 60 * 60
PURGE_INTERVAL_S = 5 * 60
MAX_UPLOAD_BYTES = int(os.environ.get("VOICE_MAX_UPLOAD_MB", "200")) * 1024 * 1024
MAX_LYRICS_CHARS = 20000

# Browser origins allowed to call the API (CORS). Default: any origin, which is right for a local
# single-user service; on a public server set VOICECOACH_ORIGINS="https://sing.example.com,...".
ORIGINS = [o.strip() for o in (os.environ.get("VOICECOACH_ORIGINS") or "*").split(",") if o.strip()]

# Robustness guard for vocal separation: when the isolated vocal is nearly silent or yields far
# fewer notes than the full mix, the "final" analysis falls back to the mix analysis.
WEAK_SEPARATION_NOTE_RATIO = 0.4
WEAK_SEPARATION_RMS_DB = -45.0
WEAK_SEPARATION_WARNING = ("Vocal separation found very little voice in this file; "
                           "using the full-mix melody")

# The built web app (web/dist). When present, this service also serves it, so Voice Coach runs
# as a single program: open http://localhost:<port>/ and the page talks to this same server.
WEB_DIST = os.environ.get("VOICECOACH_WEB_DIST") or os.path.join(os.path.dirname(SERVER_DIR), "web", "dist")
OPEN_BROWSER_URL = os.environ.get("VOICECOACH_OPEN_BROWSER")  # e.g. http://localhost:5173/

log = logging.getLogger("voicecoach")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


# ----------------------------------------------------------------- jobs

@dataclass
class Job:
    id: str
    dir: str
    input_path: str
    filename: str
    separate: bool
    created: float = field(default_factory=time.time)
    status: str = "queued"
    progress: float = 0.0
    message: str = "queued"
    meta: Dict[str, Any] = field(default_factory=dict)
    quick: Optional[Dict[str, Any]] = None
    final: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    stems: Dict[str, tuple[str, str]] = field(default_factory=dict)  # kind -> (path, mime)
    deleted: bool = False
    mix22k: Optional[np.ndarray] = None
    mix44_path: Optional[str] = None
    want_words: bool = True
    words: Optional[list] = None                 # WordTiming[] once recognition ran
    words_info: Dict[str, Any] = field(default_factory=dict)
    words_error: Optional[str] = None            # why recognition did not run / failed
    separation_weak: bool = False                # final analysis fell back to the mix analysis
    lock: threading.Lock = field(default_factory=threading.Lock)

    def set(self, status: Optional[str] = None, progress: Optional[float] = None, message: Optional[str] = None) -> None:
        with self.lock:
            if status is not None:
                self.status = status
            if progress is not None:
                self.progress = float(max(self.progress if status is None else 0.0, min(1.0, progress)))
            if message is not None:
                self.message = message

    def public(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "status": self.status,
                "progress": round(self.progress, 3),
                "message": self.message,
                "meta": self.meta or None,
                "quickReady": self.quick is not None,
                "finalReady": self.final is not None and "vocals" in self.stems,
                "wordsReady": self.words is not None,
                "wordsError": self.words_error,
                "separationWeak": self.separation_weak,
                "error": self.error,
            }


JOBS: Dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
quick_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="quick")
sep_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="separate")


def _get_job(job_id: str) -> Job:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None or job.deleted:
        raise HTTPException(status_code=404, detail="job not found")
    return job


def _remove_job_files(job: Job) -> None:
    shutil.rmtree(job.dir, ignore_errors=True)


def _purge_old_jobs() -> None:
    now = time.time()
    with JOBS_LOCK:
        old = [j for j in JOBS.values() if now - j.created > JOB_TTL_S]
        for j in old:
            JOBS.pop(j.id, None)
    for j in old:
        j.deleted = True
        _remove_job_files(j)
        log.info("purged job %s", j.id)
    # orphan dirs from previous runs
    try:
        for name in os.listdir(JOBS_ROOT):
            p = os.path.join(JOBS_ROOT, name)
            with JOBS_LOCK:
                known = any(j.dir == p for j in JOBS.values())
            if not known and os.path.isdir(p) and now - os.path.getmtime(p) > JOB_TTL_S:
                shutil.rmtree(p, ignore_errors=True)
    except FileNotFoundError:
        pass


def _purge_loop(stop: threading.Event) -> None:
    while not stop.wait(PURGE_INTERVAL_S):
        try:
            _purge_old_jobs()
        except Exception:  # pragma: no cover
            log.exception("purge failed")


# ----------------------------------------------------------------- metadata

def _parse_filename(filename: str) -> tuple[Optional[str], Optional[str]]:
    base = os.path.splitext(os.path.basename(filename or ""))[0]
    base = base.replace("_", " ").strip()
    for sep in (" - ", " – ", " — "):
        if sep in base:
            artist, title = base.split(sep, 1)
            return (title.strip() or None), (artist.strip() or None)
    return (base or None), None


def read_meta(path: str, filename: str, duration: float) -> Dict[str, Any]:
    title = artist = None
    tags: Dict[str, Any] = {}
    try:
        import mutagen

        f = mutagen.File(path, easy=True)
        if f is not None and f.tags is not None:
            for k, v in f.tags.items():
                if isinstance(v, (list, tuple)):
                    v = [str(x) for x in v]
                    tags[str(k)] = v[0] if len(v) == 1 else v
                else:
                    tags[str(k)] = str(v)
            t = tags.get("title")
            a = tags.get("artist")
            title = (t[0] if isinstance(t, list) else t) or None
            artist = (a[0] if isinstance(a, list) else a) or None
        if f is None or f.tags is None:
            raw = mutagen.File(path)
            if raw is not None and raw.tags is not None:
                for key, attr in (("TIT2", "title"), ("TPE1", "artist")):
                    frame = raw.tags.get(key) if hasattr(raw.tags, "get") else None
                    if frame is not None:
                        tags[attr] = str(frame)
                title = title or tags.get("title")
                artist = artist or tags.get("artist")
    except Exception as e:  # unreadable tags are not fatal
        log.debug("mutagen failed: %s", e)
    if not title:
        ft, fa = _parse_filename(filename)
        title = title or ft
        artist = artist or fa
    return {"title": title, "artist": artist, "duration": round(float(duration), 3), "tags": tags}


# ----------------------------------------------------------------- pipeline

def _wants_words(job: Job) -> bool:
    return job.want_words and words_mod.is_available()


def _run_words(job: Job, y: np.ndarray, p0: float, p1: float, notes: Optional[list] = None) -> None:
    """Speech recognition on `y` (22.05 kHz mono), word starts snapped to the melody's note onsets.

    Never fails the job: errors land in words_error.
    """
    if not job.want_words:
        job.words_error = "not requested"
        return
    if not words_mod.is_available():
        job.words_error = "speech model not available: faster-whisper is not installed on the analysis server"
        return
    job.set(None, p0, "finding the words (speech recognition)")

    def cb(frac: float) -> None:
        job.set(None, p0 + (p1 - p0) * frac, f"finding the words {int(frac * 100)}%")

    try:
        t0 = time.time()
        found, info = words_mod.transcribe_words(y, melody_mod.SR, progress_cb=cb)
        if notes:
            found = words_mod.snap_to_notes(found, notes)
        if job.deleted:
            return
        with job.lock:
            job.words_info = info
            job.words_error = None
            job.words = found
        log.info("job %s: %d words recognised in %.1fs", job.id, len(found), time.time() - t0)
    except words_mod.WordsUnavailable as e:
        job.words_error = str(e)
        log.warning("job %s: %s", job.id, e)
    except Exception as e:
        job.words_error = f"speech recognition failed: {e.__class__.__name__}: {e}"
        log.exception("job %s: word recognition failed", job.id)


def run_quick(job: Job) -> None:
    try:
        if job.deleted:
            return
        job.set("decoding", 0.02, "decoding audio")
        y = audio_io.decode_mono(job.input_path, melody_mod.SR)
        duration = y.size / float(melody_mod.SR)
        job.meta = read_meta(job.input_path, job.filename, duration)
        want_sep = job.separate and separate.is_available()
        want_words = _wants_words(job)
        if want_sep:
            job.mix44_path = audio_io.decode_to_wav(job.input_path, os.path.join(job.dir, "mix44.wav"))
        if job.deleted:
            return
        job.set("quick", 0.08, "quick analysis (full mix)")
        quick_end = 0.35 if want_sep else (0.7 if want_words else 1.0)

        def cb(p: float, msg: str) -> None:
            job.set(None, 0.08 + (quick_end - 0.08) * p, f"quick analysis: {msg}")

        quick = features.analyze(y, melody_mod.SR, "mix", duration=duration, progress_cb=cb)
        if job.deleted:
            return
        if want_sep:
            job.quick = quick
            job.mix22k = y
            job.set("quick", quick_end, "quick analysis ready; waiting for vocal separation")
            sep_pool.submit(run_separation, job)
        else:
            if job.separate:
                quick["warnings"].append("Vocal separation is not installed on the analysis server.")
                msg = "done (separation unavailable, mix analysis only)"
            else:
                msg = "done"
            # Words are recognised before the quick analysis is published, so a client that stops
            # polling at quickReady (and lets the job expire) still gets them.
            _run_words(job, y, quick_end, 0.98, notes=quick.get("notes"))
            if job.deleted:
                return
            job.quick = quick
            job.set("done", 1.0, msg)
    except Exception as e:
        log.exception("quick analysis failed for job %s", job.id)
        job.error = f"{e.__class__.__name__}: {e}"
        job.set("failed", None, "analysis failed")


def _separation_weak(quick: Optional[Dict[str, Any]], final: Dict[str, Any], y_voc: np.ndarray) -> Optional[str]:
    """Reason the separated vocal is not trustworthy (None when it is)."""
    rms = float(np.sqrt(np.mean(np.square(y_voc, dtype=np.float64)))) if y_voc.size else 0.0
    rms_db = 20.0 * np.log10(rms + 1e-12)
    n_final = len(final.get("notes") or [])
    n_quick = len((quick or {}).get("notes") or [])
    if rms_db < WEAK_SEPARATION_RMS_DB:
        return f"vocal stem is nearly silent ({rms_db:.0f} dBFS)"
    if n_quick > 0 and n_final < WEAK_SEPARATION_NOTE_RATIO * n_quick:
        return f"separated vocal gave {n_final} notes vs {n_quick} from the mix"
    return None


def run_separation(job: Job) -> None:
    try:
        if job.deleted:
            return
        job.set("separating", 0.36, "separating vocals (Demucs, CPU)")
        stems_dir = os.path.join(job.dir, "stems")

        def cb(frac: float) -> None:
            job.set(None, 0.36 + 0.5 * frac, f"separating vocals {int(frac * 100)}%")

        voc_path, ins_path = separate.separate(job.mix44_path, stems_dir, cb)
        if job.deleted:
            return
        job.set("finalizing", 0.88, "analysing isolated vocal")
        voc_wav = os.path.join(stems_dir, "vocals.wav")
        y_voc = audio_io.decode_mono(voc_wav if os.path.exists(voc_wav) else voc_path, melody_mod.SR)
        mix = job.mix22k if job.mix22k is not None else audio_io.decode_mono(job.input_path, melody_mod.SR)
        duration = mix.size / float(melody_mod.SR)
        if y_voc.size < mix.size:
            y_voc = np.pad(y_voc, (0, mix.size - y_voc.size))
        y_voc = y_voc[: mix.size]

        def cb2(p: float, msg: str) -> None:
            job.set(None, 0.88 + 0.06 * p, f"final analysis: {msg}")

        final = features.analyze(y_voc, melody_mod.SR, "separated", y_mix_for_key=mix,
                                 duration=duration, progress_cb=cb2)
        if job.deleted:
            return
        weak_reason = _separation_weak(job.quick, final, y_voc)
        y_for_words = y_voc
        if weak_reason is not None:
            # Keep the stems (the user may still want the backing track) but never hand out an
            # empty song: the final analysis becomes the full-mix one, clearly labelled.
            log.warning("job %s: weak separation (%s); final analysis falls back to the mix", job.id, weak_reason)
            final = copy.deepcopy(job.quick)
            final["warnings"] = [w for w in final.get("warnings", []) if w != features.MIX_WARNING]
            final["warnings"].append(WEAK_SEPARATION_WARNING)
            job.separation_weak = True
            y_for_words = mix
        # Words are recognised before the final result is published: finalReady implies wordsReady
        # (or wordsError), so a client that deletes the job on finalReady loses nothing.
        _run_words(job, y_for_words, 0.94, 0.99, notes=final.get("notes"))
        if job.deleted:
            return
        _, mime = audio_io.stem_format()
        with job.lock:
            job.stems = {"vocals": (voc_path, mime), "instrumental": (ins_path, mime)}
            job.final = final
        for p in (voc_wav, os.path.join(stems_dir, "instrumental.wav"), job.mix44_path):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        job.mix22k = None
        job.set("done", 1.0, "done")
    except Exception as e:
        log.exception("separation failed for job %s", job.id)
        job.error = f"{e.__class__.__name__}: {e}"
        job.mix22k = None
        job.set("failed", None, "vocal separation failed; quick analysis is still available")


def _warm_up() -> None:
    """Compile numba/librosa code paths in the worker thread so the first job is fast."""
    try:
        t0 = time.time()
        sr = melody_mod.SR
        t = np.arange(int(sr * 1.5)) / sr
        y = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        melody_mod.extract_f0(y, sr, "mix")
        melody_mod.extract_f0(y, sr, "separated")
        features.detect_tempo(np.tile(y, 2), sr)
        log.info("warm-up done in %.1fs", time.time() - t0)
    except Exception:  # pragma: no cover
        log.exception("warm-up failed")


# ----------------------------------------------------------------- app

@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(JOBS_ROOT, exist_ok=True)
    _purge_old_jobs()
    stop = threading.Event()
    threading.Thread(target=_purge_loop, args=(stop,), daemon=True, name="purge").start()
    quick_pool.submit(_warm_up)
    log.info("separation: %s (%s); stems as %s", "demucs" if separate.is_available() else "unavailable",
             separate.device(), audio_io.stem_format()[0])
    log.info("word timing: %s; coach: %s (model %s, key from %s); origins: %s",
             f"faster-whisper '{words_mod.MODEL_SIZE}'" if words_mod.is_available() else "unavailable",
             "anthropic sdk" if coach.is_available() else "unavailable", coach.MODEL, coach.resolve_key()[1],
             ",".join(ORIGINS))
    if os.path.isfile(os.path.join(WEB_DIST, "index.html")):
        log.info("serving the web app from %s", WEB_DIST)
    if OPEN_BROWSER_URL:
        threading.Timer(1.5, lambda: webbrowser.open(OPEN_BROWSER_URL)).start()
    yield
    stop.set()
    quick_pool.shutdown(wait=False, cancel_futures=True)
    sep_pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Voice coach analysis service", version=VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "separation": "demucs" if separate.is_available() else "unavailable",
        "device": separate.device(),
        "version": VERSION,
        "whisper": words_mod.is_available(),
        "whisperModel": words_mod.MODEL_SIZE if words_mod.is_available() else None,
        "coach": coach.is_available(),
    }


def _parse_bool(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


@app.post("/analyze")
async def analyze(file: UploadFile = File(...), separate_: str = Form("false", alias="separate"),
                  words_: str = Form("true", alias="words")) -> Dict[str, str]:
    job_id = uuid.uuid4().hex[:16]
    os.makedirs(JOBS_ROOT, exist_ok=True)
    job_dir = tempfile.mkdtemp(prefix=f"job-{job_id}-", dir=JOBS_ROOT)
    ext = os.path.splitext(file.filename or "")[1].lower()
    if not ext or len(ext) > 8 or not ext[1:].isalnum():
        ext = ".bin"
    input_path = os.path.join(job_dir, "input" + ext)
    size = 0
    try:
        with open(input_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="file too large")
                out.write(chunk)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    if size == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="empty upload")
    job = Job(id=job_id, dir=job_dir, input_path=input_path, filename=file.filename or "",
              separate=_parse_bool(separate_), want_words=_parse_bool(words_))
    with JOBS_LOCK:
        JOBS[job_id] = job
    quick_pool.submit(run_quick, job)
    log.info("job %s queued (%s, %.1f MB, separate=%s, words=%s)", job_id, file.filename, size / 1e6,
             job.separate, job.want_words)
    return {"jobId": job_id}


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> Dict[str, Any]:
    return _get_job(job_id).public()


@app.get("/jobs/{job_id}/analysis/quick")
def job_quick(job_id: str) -> JSONResponse:
    job = _get_job(job_id)
    if job.quick is None:
        raise HTTPException(status_code=404, detail="quick analysis not ready")
    return JSONResponse(job.quick)


@app.get("/jobs/{job_id}/analysis/final")
def job_final(job_id: str) -> JSONResponse:
    job = _get_job(job_id)
    if job.final is None:
        raise HTTPException(status_code=404, detail="final analysis not ready")
    return JSONResponse(job.final)


def _stem(job_id: str, kind: str) -> FileResponse:
    job = _get_job(job_id)
    with job.lock:
        entry = job.stems.get(kind)
    if entry is None or not os.path.exists(entry[0]):
        raise HTTPException(status_code=404, detail=f"{kind} stem not ready")
    path, mime = entry
    return FileResponse(path, media_type=mime, filename=os.path.basename(path))


@app.get("/jobs/{job_id}/stems/vocals")
def stem_vocals(job_id: str) -> FileResponse:
    return _stem(job_id, "vocals")


@app.get("/jobs/{job_id}/stems/instrumental")
def stem_instrumental(job_id: str) -> FileResponse:
    return _stem(job_id, "instrumental")


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str) -> Dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.pop(job_id, None)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    job.deleted = True
    job.mix22k = None
    _remove_job_files(job)
    return {"ok": True}


class IdentifyBody(BaseModel):
    url: str


class LyricsBody(BaseModel):
    title: str
    artist: str = ""
    duration: Optional[float] = None


@app.post("/identify")
def identify(body: IdentifyBody) -> Dict[str, Any]:
    try:
        return lyrics.identify(body.url)
    except lyrics.LookupError as e:
        raise HTTPException(status_code=502, detail=f"identify lookup failed: {e}")
    except Exception as e:  # never crash on odd input
        raise HTTPException(status_code=502, detail=f"identify lookup failed: {e.__class__.__name__}")


@app.post("/lyrics/search")
def lyrics_search(body: LyricsBody) -> Dict[str, Any]:
    try:
        return lyrics.search_lyrics(body.title, body.artist, body.duration)
    except lyrics.LookupError as e:
        raise HTTPException(status_code=502, detail=f"lyrics lookup failed: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"lyrics lookup failed: {e.__class__.__name__}")


# ----------------------------------------------------------------- word timing

class AlignBody(BaseModel):
    lyrics: str


def _words_or_error(job: Job) -> list:
    """The job's recognised words, or the right HTTP error (404 until ready, 503 when unavailable)."""
    with job.lock:
        found = job.words
        err = job.words_error
    if found is not None:
        return found
    if not words_mod.is_available():
        raise HTTPException(status_code=503, detail="speech model not available: faster-whisper is not "
                                                    "installed on the analysis server (pip install -r requirements-words.txt)")
    if err == "not requested":
        raise HTTPException(status_code=404, detail="word timing was not requested for this job")
    if err:
        raise HTTPException(status_code=503, detail=err)
    raise HTTPException(status_code=404, detail="words not ready")


@app.get("/jobs/{job_id}/words")
def job_words(job_id: str) -> Dict[str, Any]:
    job = _get_job(job_id)
    found = _words_or_error(job)
    with job.lock:
        info = dict(job.words_info)
    return {"words": found, "language": info.get("language"),
            "languageProbability": info.get("languageProbability"), "model": info.get("model")}


@app.post("/jobs/{job_id}/align")
def job_align(job_id: str, body: AlignBody) -> Dict[str, Any]:
    job = _get_job(job_id)
    if len(body.lyrics or "") > MAX_LYRICS_CHARS:
        raise HTTPException(status_code=413, detail="lyrics too long")
    found = _words_or_error(job)
    analysis = job.final or job.quick or {}
    phrases = analysis.get("phrases") or []
    if phrases:
        span = (float(phrases[0]["start"]), float(phrases[-1]["end"]))
    else:
        span = (0.0, float((job.meta or {}).get("duration") or analysis.get("duration") or 0.0) or 1.0)
    aligned = words_mod.align_lyrics(body.lyrics, found, span=span)
    matched = sum(1 for w in aligned if w["conf"] > 0)
    return {"words": aligned, "matched": matched, "total": len(aligned)}


# ----------------------------------------------------------------- AI coach

class CoachKeyBody(BaseModel):
    key: str = ""


class CoachMessageBody(BaseModel):
    role: str
    content: str


class CoachChatBody(BaseModel):
    messages: list[CoachMessageBody]
    context: Any = None


class CoachPlanBody(BaseModel):
    context: Any = None


@app.get("/coach/status")
def coach_status() -> Dict[str, Any]:
    return coach.status()


@app.post("/coach/key")
def coach_key(body: CoachKeyBody) -> Dict[str, Any]:
    try:
        coach.save_key(body.key)
    except coach.CoachError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"could not store the key: {e.__class__.__name__}")
    st = coach.status()
    if body.key.strip() and st.get("keySource") == "env":
        st["message"] = "The key was saved, but ANTHROPIC_API_KEY in the server's environment takes precedence."
    return st


@app.post("/coach")
def coach_chat(body: CoachChatBody) -> Dict[str, str]:
    try:
        reply = coach.chat([m.model_dump() for m in body.messages], body.context)
    except coach.CoachError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return {"reply": reply}


@app.post("/coach/plan")
def coach_plan(body: CoachPlanBody) -> Dict[str, Any]:
    try:
        return coach.plan(body.context)
    except coach.CoachError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


# ----------------------------------------------------------------- web app (single-program mode)

# Windows can map .js to text/plain in the registry, which breaks module scripts and workers.
for _ext, _type in ((".js", "text/javascript"), (".mjs", "text/javascript"), (".css", "text/css"),
                    (".svg", "image/svg+xml"), (".wasm", "application/wasm"), (".json", "application/json")):
    mimetypes.add_type(_type, _ext)


@app.get("/{full_path:path}", include_in_schema=False)
def web_app(full_path: str):
    """Serve web/dist; unknown paths get index.html so the app's own routes survive a page refresh."""
    index = os.path.join(WEB_DIST, "index.html")
    if not os.path.isfile(index):
        raise HTTPException(status_code=404, detail="web app not built (run `npm run build` in web/)")
    root = os.path.realpath(WEB_DIST)
    candidate = os.path.realpath(os.path.join(root, full_path))
    if full_path and candidate.startswith(root + os.sep) and os.path.isfile(candidate):
        media_type = mimetypes.guess_type(candidate)[0]
        headers = {"Cache-Control": "public, max-age=31536000, immutable"} if "/assets/" in candidate.replace(os.sep, "/") else {}
        return FileResponse(candidate, media_type=media_type, headers=headers)
    return FileResponse(index, media_type="text/html", headers={"Cache-Control": "no-cache"})
