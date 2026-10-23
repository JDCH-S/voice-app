"""Optional vocal separation with Demucs (htdemucs) on CPU.

torch / demucs are imported lazily so the service starts without them.
`separate()` writes mono 44.1 kHz wavs (vocals.wav, instrumental.wav) to
`out_dir`, encodes them with audio_io (mp3 when libmp3lame exists) and returns
the encoded paths.  instrumental = mixture - vocals.

Model weights are fetched by Demucs on first use (torch hub cache); set
DEMUCS_REPO to a directory with the model files to run fully offline.
"""

from __future__ import annotations

import functools
import os
from pathlib import Path
from typing import Callable, Optional, Tuple

import numpy as np
import soundfile as sf

from . import audio_io

MODEL_NAME = os.environ.get("DEMUCS_MODEL", "htdemucs")
NUM_THREADS = int(os.environ.get("DEMUCS_THREADS", "4"))
ProgressCb = Optional[Callable[[float], None]]


@functools.lru_cache(maxsize=1)
def is_available() -> bool:
    try:
        import torch  # noqa: F401
        import demucs.api  # noqa: F401
    except Exception:
        return False
    return True


def device() -> str:
    try:
        import torch
    except Exception:
        return "cpu"
    try:
        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


_separator = None


def _get_separator(callback):
    """Build (and cache) the Separator; the callback is swapped per call."""
    global _separator
    import torch
    from demucs.api import Separator

    torch.set_num_threads(max(1, NUM_THREADS))
    if _separator is None:
        kwargs = dict(model=MODEL_NAME, device=device(), shifts=1, overlap=0.25, split=True,
                      progress=False, jobs=0)
        repo = os.environ.get("DEMUCS_REPO")
        if repo:
            kwargs["repo"] = Path(repo)
        _separator = Separator(**kwargs)
    _separator.update_parameter(callback=callback, callback_arg=None)
    return _separator


def separate(wav_path: str, out_dir: str, progress_cb: ProgressCb = None) -> Tuple[str, str]:
    """Separate `wav_path` (any wav; 44.1 kHz stereo preferred) into vocals / instrumental.

    Returns (vocals_path, instrumental_path) of the encoded stems. The mono wav
    intermediates stay in out_dir as vocals.wav / instrumental.wav.
    """
    import torch

    os.makedirs(out_dir, exist_ok=True)
    data, sr = sf.read(wav_path, dtype="float32", always_2d=True)  # (n, ch)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    wav = torch.from_numpy(np.ascontiguousarray(data.T))  # (ch, n)

    state = {"best": 0.0}
    shifts = 1

    def cb(info):
        # demucs calls this with a dict: audio_length, segment_offset, shift_idx,
        # model_idx_in_bag, models (bag size), state ("start"/"end").
        try:
            if info.get("state") != "end":
                return
            length = max(float(info.get("audio_length") or 0), 1.0)
            models = max(int(info.get("models") or 1), 1)
            model_idx = int(info.get("model_idx_in_bag") or 0)
            shift_idx = int(info.get("shift_idx") or 0)
            offset = float(info.get("segment_offset") or 0)
            within = min(1.0, (offset + 0.5 * length / 10.0) / length)
            frac = (model_idx + (shift_idx + within) / shifts) / models
            frac = max(state["best"], min(frac, 0.99))
            state["best"] = frac
            if progress_cb:
                progress_cb(frac)
        except Exception:
            pass

    try:
        sep = _get_separator(cb)
    except Exception as e:
        raise RuntimeError(
            f"could not load Demucs model '{MODEL_NAME}' (weights are downloaded on first use; "
            f"if the network is blocked, set DEMUCS_REPO to a folder with the model files): "
            f"{e.__class__.__name__}: {e}"
        ) from e
    with torch.no_grad():
        origin, stems = sep.separate_tensor(wav, sr=sr)
    vocals = stems.get("vocals")
    if vocals is None:
        raise RuntimeError("model produced no 'vocals' stem")
    n = min(origin.shape[-1], vocals.shape[-1])
    origin = origin[..., :n]
    vocals = vocals[..., :n]
    instrumental = origin - vocals
    out_sr = int(getattr(sep, "samplerate", 44100))

    voc_mono = vocals.mean(dim=0).cpu().numpy()
    ins_mono = instrumental.mean(dim=0).cpu().numpy()
    peak = max(float(np.max(np.abs(voc_mono))), float(np.max(np.abs(ins_mono))), 1e-9)
    if peak > 1.0:  # mono fold can clip slightly; keep both stems at the same gain
        voc_mono = voc_mono / peak
        ins_mono = ins_mono / peak

    voc_wav = os.path.join(out_dir, "vocals.wav")
    ins_wav = os.path.join(out_dir, "instrumental.wav")
    audio_io.write_wav(voc_wav, voc_mono, out_sr)
    audio_io.write_wav(ins_wav, ins_mono, out_sr)
    if progress_cb:
        progress_cb(0.99)
    voc_path, _ = audio_io.encode_stem(voc_wav, os.path.join(out_dir, "vocals"))
    ins_path, _ = audio_io.encode_stem(ins_wav, os.path.join(out_dir, "instrumental"))
    if progress_cb:
        progress_cb(1.0)
    return voc_path, ins_path
