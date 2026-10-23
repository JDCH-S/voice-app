"""Song-level features and SongAnalysis assembly (docs/ANALYSIS_SCHEMA.md)."""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, Optional

import librosa
import numpy as np

from . import melody as melody_mod
from .notes import prune_mix_outliers, segment_notes, strip_private
from .phrases import build_phrases

SCHEMA_VERSION = 1
MIX_WARNING = ("Vocal separation unavailable or still running; melody extracted from the "
               "full mix and may pick up instruments.")

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Krumhansl-Kessler key profiles
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KEY_FULL_CONFIDENCE_MARGIN = 0.25   # correlation margin that maps to confidence 1.0


def to_jsonable(obj: Any) -> Any:
    """Recursively convert numpy types to plain Python and NaN/inf to None/0."""
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [to_jsonable(v) for v in obj.tolist()]
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        obj = float(obj)
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return 0.0
        return obj
    return obj


def detect_key(y_mix: np.ndarray, sr: int) -> Optional[Dict[str, Any]]:
    """Krumhansl-Schmuckler on the mean chroma (CQT) of the full mix."""
    try:
        if y_mix.size < sr:
            return None
        chroma = librosa.feature.chroma_cqt(y=y_mix, sr=sr, hop_length=2048)
        prof = np.mean(chroma, axis=1)
        if not np.all(np.isfinite(prof)) or np.sum(prof) <= 0:
            return None
        prof = prof / np.sum(prof)
        scores = []
        for tonic in range(12):
            for name, template in (("major", _MAJOR), ("minor", _MINOR)):
                r = float(np.corrcoef(prof, np.roll(template, tonic))[0, 1])
                scores.append((r, tonic, name))
        scores.sort(reverse=True)
        best, second = scores[0], scores[1]
        conf = (best[0] - second[0]) / KEY_FULL_CONFIDENCE_MARGIN
        conf = float(max(0.0, min(1.0, conf)))
        return {"tonic": NOTE_NAMES[best[1]], "mode": best[2], "confidence": round(conf, 3)}
    except Exception:
        return None


def detect_tempo(y_mix: np.ndarray, sr: int) -> Optional[float]:
    try:
        if y_mix.size < 2 * sr:
            return None
        onset_env = librosa.onset.onset_strength(y=y_mix, sr=sr)
        tempo, _ = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
        tempo = float(np.atleast_1d(tempo)[0])
        if not np.isfinite(tempo) or tempo <= 0:
            return None
        return round(tempo, 2)
    except Exception:
        return None


def voiced_range(hz: np.ndarray) -> Dict[str, float]:
    v = hz[hz > 0]
    if v.size == 0:
        return {"lowMidi": 0.0, "highMidi": 0.0, "p05": 0.0, "p95": 0.0}
    midi = 69.0 + 12.0 * np.log2(v / 440.0)
    p02, p05, p95, p98 = np.percentile(midi, [2, 5, 95, 98])
    return {
        "lowMidi": round(float(p02), 2),
        "highMidi": round(float(p98), 2),
        "p05": round(float(p05), 2),
        "p95": round(float(p95), 2),
    }


def analyze(y: np.ndarray, sr: int, mode: str, y_mix_for_key: Optional[np.ndarray] = None, *,
            duration: Optional[float] = None,
            progress_cb: Optional[Callable[[float, str], None]] = None) -> Dict[str, Any]:
    """Full SongAnalysis for `y` (isolated vocal when mode == "separated", else the mix).

    `y_mix_for_key` is the full mix used for key/tempo (defaults to `y`).
    """
    if mode not in ("mix", "separated"):
        raise ValueError("mode must be 'mix' or 'separated'")
    y = np.asarray(y, dtype=np.float32)
    y_mix = y if y_mix_for_key is None else np.asarray(y_mix_for_key, dtype=np.float32)
    if duration is None:
        duration = y.size / float(sr)

    def report(p: float, msg: str) -> None:
        if progress_cb:
            progress_cb(p, msg)

    report(0.05, "extracting melody")
    mel = melody_mod.extract_f0(y, sr, mode)
    report(0.55, "segmenting notes")
    notes = segment_notes(mel, mode=mode, y=y if mode == "separated" else None, sr=sr)
    if mode == "mix":
        notes, pruned = prune_mix_outliers(notes)
        for fs, fe in pruned:  # keep the melody track consistent with the note list
            mel["hz"][fs:fe] = 0.0
    strip_private(notes)
    rng = voiced_range(mel["hz"])
    phrases, breaths = build_phrases(notes, duration, rng)
    report(0.7, "detecting key")
    key = detect_key(y_mix, sr)
    report(0.8, "detecting tempo")
    tempo = detect_tempo(y_mix, sr)
    report(0.95, "finishing")

    warnings = []
    if mode == "mix":
        warnings.append(MIX_WARNING)
    if not notes:
        warnings.append("No sung notes were detected.")

    hz = np.round(mel["hz"], 2)
    rms_db = np.round(mel["rmsDb"], 1)
    analysis = {
        "version": SCHEMA_VERSION,
        "mode": mode,
        "duration": round(float(duration), 3),
        "key": key,
        "tempoBpm": tempo,
        "melody": {
            "t0": float(mel["t0"]),
            "hop": float(mel["hop"]),
            "hz": hz,
            "rmsDb": rms_db,
        },
        "notes": notes,
        "phrases": phrases,
        "breaths": breaths,
        "range": rng,
        "warnings": warnings,
    }
    return to_jsonable(analysis)
