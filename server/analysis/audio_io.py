"""Audio decoding / encoding through ffmpeg.

Everything goes through the ffmpeg binary (subprocess) so that any container
or codec the user uploads (mp3, m4a, ogg, flac, wav, webm, ...) works the same
way.  Decoded analysis audio is mono float32 at 22050 Hz; a 44.1 kHz stereo
wav copy is kept as Demucs input.
"""

from __future__ import annotations

import functools
import os
import shutil
import subprocess
from typing import Optional

import numpy as np
import soundfile as sf

FFMPEG = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
ANALYSIS_SR = 22050
STEM_SR = 44100


class AudioDecodeError(RuntimeError):
    pass


def _run(cmd: list[str], *, capture: bool = True, timeout: float = 600.0) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as e:  # pragma: no cover - environment problem
        raise AudioDecodeError(f"ffmpeg not found at {FFMPEG}") from e
    except subprocess.TimeoutExpired as e:
        raise AudioDecodeError("ffmpeg timed out") from e


def _tail(stderr: bytes, n: int = 400) -> str:
    txt = stderr.decode("utf-8", "replace").strip()
    return txt[-n:] if len(txt) > n else txt


def decode_mono(path: str, sr: int = ANALYSIS_SR) -> np.ndarray:
    """Decode any audio file to mono float32 at `sr` Hz (raw f32le via ffmpeg stdout)."""
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-",
    ]
    proc = _run(cmd)
    if proc.returncode != 0 or not proc.stdout:
        raise AudioDecodeError(f"could not decode audio: {_tail(proc.stderr) or 'no audio data'}")
    y = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    if y.size < sr // 10:
        raise AudioDecodeError("audio is too short (< 0.1 s)")
    # Guard against NaN/inf from broken files and against hot clipping.
    y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 1.0:
        y = y / peak
    return y


def decode_to_wav(path: str, out_path: str, sr: int = STEM_SR, channels: int = 2) -> str:
    """Transcode to a 16-bit PCM wav (default 44.1 kHz stereo) for Demucs."""
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", path, "-vn", "-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_s16le", out_path,
    ]
    proc = _run(cmd)
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise AudioDecodeError(f"could not transcode audio: {_tail(proc.stderr)}")
    return out_path


def write_wav(path: str, y: np.ndarray, sr: int) -> str:
    """Write float audio (shape (n,) or (n, ch)) as 16-bit PCM wav."""
    y = np.asarray(y, dtype=np.float32)
    y = np.clip(y, -1.0, 1.0)
    sf.write(path, y, sr, subtype="PCM_16")
    return path


@functools.lru_cache(maxsize=1)
def has_mp3_encoder() -> bool:
    try:
        proc = _run([FFMPEG, "-hide_banner", "-encoders"], timeout=30)
    except AudioDecodeError:
        return False
    return b"libmp3lame" in proc.stdout


def stem_format() -> tuple[str, str]:
    """(extension, mime type) used for encoded stems."""
    return ("mp3", "audio/mpeg") if has_mp3_encoder() else ("wav", "audio/wav")


def encode_stem(wav_path: str, out_base: str) -> tuple[str, str]:
    """Encode a stem to mono mp3 (libmp3lame -q:a 4) if available, else 16-bit mono wav.

    Returns (output_path, mime_type).
    """
    ext, mime = stem_format()
    out_path = f"{out_base}.{ext}"
    if ext == "mp3":
        cmd = [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", wav_path, "-vn", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "4", out_path,
        ]
    else:
        cmd = [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", wav_path, "-vn", "-ac", "1", "-c:a", "pcm_s16le", out_path,
        ]
    proc = _run(cmd)
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise AudioDecodeError(f"could not encode stem: {_tail(proc.stderr)}")
    return out_path, mime


def probe_duration(path: str) -> Optional[float]:
    """Duration in seconds via ffprobe (None when unavailable)."""
    ffprobe = shutil.which("ffprobe") or os.path.join(os.path.dirname(FFMPEG), "ffprobe")
    try:
        proc = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=60,
        )
        val = float(proc.stdout.decode().strip())
        return val if np.isfinite(val) and val > 0 else None
    except Exception:
        return None
