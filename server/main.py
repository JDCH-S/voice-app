"""Voice coach analysis service.

Run:  uvicorn main:app --port 8765
See docs/ANALYSIS_SCHEMA.md for the API contract and server/README.md for usage.
"""

from __future__ import annotations

import logging
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

from analysis import audio_io, features, lyrics, separate
from analysis import melody as melody_mod

VERSION = "0.1.0"
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
JOBS_ROOT = os.environ.get("VOICE_JOBS_DIR") or os.path.join(SERVER_DIR, ".jobs")
JOB_TTL_S = 2 * 60 * 60
PURGE_INTERVAL_S = 5 * 60
MAX_UPLOAD_BYTES = int(os.environ.get("VOICE_MAX_UPLOAD_MB", "200")) * 1024 * 1024

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

def run_quick(job: Job) -> None:
    try:
        if job.deleted:
            return
        job.set("decoding", 0.02, "decoding audio")
        y = audio_io.decode_mono(job.input_path, melody_mod.SR)
        duration = y.size / float(melody_mod.SR)
        job.meta = read_meta(job.input_path, job.filename, duration)
        want_sep = job.separate and separate.is_available()
        if want_sep:
            job.mix44_path = audio_io.decode_to_wav(job.input_path, os.path.join(job.dir, "mix44.wav"))
        if job.deleted:
            return
        job.set("quick", 0.08, "quick analysis (full mix)")
        quick_end = 0.35 if want_sep else 1.0

        def cb(p: float, msg: str) -> None:
            job.set(None, 0.08 + (quick_end - 0.08) * p, f"quick analysis: {msg}")

        job.quick = features.analyze(y, melody_mod.SR, "mix", duration=duration, progress_cb=cb)
        if job.deleted:
            return
        if want_sep:
            job.mix22k = y
            job.set("quick", quick_end, "quick analysis ready; waiting for vocal separation")
            sep_pool.submit(run_separation, job)
        else:
            if job.separate:
                job.quick["warnings"].append("Vocal separation is not installed on the analysis server.")
                msg = "done (separation unavailable, mix analysis only)"
            else:
                msg = "done"
            job.set("done", 1.0, msg)
    except Exception as e:
        log.exception("quick analysis failed for job %s", job.id)
        job.error = f"{e.__class__.__name__}: {e}"
        job.set("failed", None, "analysis failed")


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
            job.set(None, 0.88 + 0.11 * p, f"final analysis: {msg}")

        final = features.analyze(y_voc, melody_mod.SR, "separated", y_mix_for_key=mix,
                                 duration=duration, progress_cb=cb2)
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
    yield
    stop.set()
    quick_pool.shutdown(wait=False, cancel_futures=True)
    sep_pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Voice coach analysis service", version=VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    }


def _parse_bool(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


@app.post("/analyze")
async def analyze(file: UploadFile = File(...), separate_: str = Form("false", alias="separate")) -> Dict[str, str]:
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
              separate=_parse_bool(separate_))
    with JOBS_LOCK:
        JOBS[job_id] = job
    quick_pool.submit(run_quick, job)
    log.info("job %s queued (%s, %.1f MB, separate=%s)", job_id, file.filename, size / 1e6, job.separate)
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
