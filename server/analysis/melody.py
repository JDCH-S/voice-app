"""Frame-wise fundamental frequency of the vocal line.

`extract_f0` runs librosa.pyin and cleans the track up: voicing gated by pyin's
voiced probability and the frame level, median smoothing within voiced runs,
removal of tiny voiced islands and folding of short octave glitches.

Frame i is centred at t0 + i*hop seconds, hop = 256/22050 ~ 11.6 ms.
"""

from __future__ import annotations

import threading
from typing import Dict, List, Tuple

import librosa
import numpy as np
from scipy.signal import butter, medfilt, sosfiltfilt

SR = 22050
HOP = 256
FRAME = 2048
FMAX = 1100.0
FMIN_SEPARATED = 65.0   # C2
FMIN_MIX = 80.0
MIN_ISLAND_FRAMES = 4
OCTAVE_FIX_MAX_MS = 150.0
OCTAVE_FIX_TOL_CENTS = 80.0
# mix mode only: attenuate bass/chord roots below the vocal range before pyin and
# use a more permissive YIN threshold prior (polyphony makes the troughs shallow).
MIX_HIGHPASS_HZ = 150.0
MIX_BETA_PARAMETERS = (2, 8)
SEPARATED_BETA_PARAMETERS = (2, 18)   # librosa default
PARITY_EVEN_ODD_RATIO = 4.0

# numba JIT in pyin is not guaranteed to be thread safe on the first compile,
# and two pyin calls in parallel would just fight for the cores anyway.
_pyin_lock = threading.Lock()


def hz_to_midi(hz: np.ndarray) -> np.ndarray:
    hz = np.asarray(hz, dtype=np.float64)
    out = np.full(hz.shape, np.nan)
    m = hz > 0
    out[m] = 69.0 + 12.0 * np.log2(hz[m] / 440.0)
    return out


def midi_to_hz(midi: np.ndarray | float) -> np.ndarray | float:
    return 440.0 * np.power(2.0, (np.asarray(midi, dtype=np.float64) - 69.0) / 12.0)


def voiced_runs(voiced: np.ndarray) -> List[Tuple[int, int]]:
    """[(start, end_exclusive), ...] of consecutive True frames."""
    v = np.asarray(voiced, dtype=bool)
    if v.size == 0:
        return []
    d = np.diff(np.concatenate(([0], v.astype(np.int8), [0])))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return list(zip(starts.tolist(), ends.tolist()))


def frame_rms_db(y: np.ndarray, frame_length: int = FRAME, hop_length: int = HOP) -> np.ndarray:
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
    db = 20.0 * np.log10(np.maximum(rms, 1e-5))
    return np.maximum(db, -100.0)


def _median_within_runs(f0: np.ndarray, voiced: np.ndarray, k: int = 5) -> np.ndarray:
    out = f0.copy()
    for s, e in voiced_runs(voiced):
        n = e - s
        if n >= k:
            out[s:e] = medfilt(f0[s:e], kernel_size=k)
            # medfilt zero-pads the edges; keep the raw values there instead
            h = k // 2
            out[s:s + h] = np.median(f0[s:s + k])
            out[e - h:e] = np.median(f0[e - k:e])
        elif n >= 3:
            out[s:e] = np.median(f0[s:e])
    return out


def _remove_short_islands(voiced: np.ndarray, min_frames: int) -> np.ndarray:
    out = voiced.copy()
    for s, e in voiced_runs(voiced):
        if e - s < min_frames:
            out[s:e] = False
    return out


def _bridge_short_holes(f0: np.ndarray, voiced: np.ndarray, max_frames: int) -> Tuple[np.ndarray, np.ndarray]:
    """Interpolate over unvoiced holes <= max_frames whose neighbours are within 1 semitone."""
    f0 = f0.copy()
    voiced = voiced.copy()
    runs = voiced_runs(voiced)
    for (s0, e0), (s1, e1) in zip(runs[:-1], runs[1:]):
        hole = s1 - e0
        if 0 < hole <= max_frames:
            a, b = f0[e0 - 1], f0[s1]
            if a > 0 and b > 0 and abs(12.0 * np.log2(b / a)) <= 1.0:
                f0[e0:s1] = np.geomspace(a, b, hole + 2)[1:-1]
                voiced[e0:s1] = True
    return f0, voiced


def _fix_octave_jumps(f0: np.ndarray, voiced: np.ndarray, hop_s: float) -> np.ndarray:
    """Fold short sub-runs that sit an octave away from both of their neighbours."""
    out = f0.copy()
    max_frames = int(round(OCTAVE_FIX_MAX_MS / 1000.0 / hop_s))
    tol = OCTAVE_FIX_TOL_CENTS / 100.0
    for s, e in voiced_runs(voiced):
        if e - s < 3:
            continue
        for _ in range(3):  # a few passes so that chains of glitches resolve
            midi = hz_to_midi(out[s:e])
            # split the run into sub-runs at jumps > 6 semitones
            jumps = np.flatnonzero(np.abs(np.diff(midi)) > 6.0) + 1
            bounds = [0, *jumps.tolist(), e - s]
            segs = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
            if len(segs) < 3:
                break
            changed = False
            meds = [float(np.median(midi[a:b])) for a, b in segs]
            for i in range(1, len(segs) - 1):
                a, b = segs[i]
                if b - a > max_frames:
                    continue
                d_prev = meds[i] - meds[i - 1]
                d_next = meds[i] - meds[i + 1]
                for octs in (12.0, 24.0, -12.0, -24.0):
                    if abs(d_prev - octs) <= tol and abs(d_next - octs) <= tol:
                        out[s + a:s + b] = out[s + a:s + b] * (2.0 ** (-octs / 12.0))
                        meds[i] -= octs
                        changed = True
                        break
            if not changed:
                break
    return out


def _fix_sub_octave_by_parity(src: np.ndarray, f0: np.ndarray, sr: int) -> np.ndarray:
    """Double f0 where the even harmonics (2,4,6) carry >> energy than the odd ones (1,3,5).

    In a mix, pyin often locks onto a bass/chord root one octave below the voice;
    the voice's own harmonic series then sits on the even harmonics of that f0.
    """
    out = f0.copy()
    idx = np.flatnonzero(f0 > 0)
    if idx.size == 0:
        return out
    n_fft = FRAME
    win = np.hanning(n_fft).astype(np.float32)
    bin_hz = sr / n_fft
    half = n_fft // 2
    padded = np.pad(src.astype(np.float32), (half, half))
    chunk = 2048
    for c in range(0, idx.size, chunk):
        fr = idx[c:c + chunk]
        starts = fr * HOP  # frame i is centred at i*HOP in the unpadded signal
        mat = np.stack([padded[s:s + n_fft] for s in starts]) * win
        power = np.abs(np.fft.rfft(mat, axis=1)) ** 2
        nb = power.shape[1]
        odd = np.zeros(fr.size)
        even = np.zeros(fr.size)
        rows = np.arange(fr.size)
        for k in range(1, 7):
            b = np.round(k * f0[fr] / bin_hz).astype(int)
            ok = (b >= 1) & (b + 1 < nb)
            e = np.zeros(fr.size)
            for d in (-1, 0, 1):
                e[ok] += power[rows[ok], b[ok] + d]
            if k % 2:
                odd += e
            else:
                even += e
        dbl = (even > PARITY_EVEN_ODD_RATIO * odd) & (f0[fr] * 2.0 <= FMAX)
        out[fr[dbl]] = f0[fr[dbl]] * 2.0
    return out


def extract_f0(y: np.ndarray, sr: int = SR, mode: str = "mix") -> Dict[str, np.ndarray | float]:
    """Return {"hz", "rmsDb", "t0", "hop", "voicedProb"} for mono audio at `sr`.

    mode "mix": full mix fallback - pyin on the harmonic part (HPSS, high-passed at
      150 Hz, permissive threshold prior), fmin 80 Hz, sub-octave errors fixed by
      harmonic parity; voiced when voiced_prob > 0.5 and the frame RMS is above
      median RMS - 10 dB.
    mode "separated": isolated vocal - fmin 65 Hz, voiced when voiced_prob > 0.35
      and the frame RMS is above -45 dBFS.
    """
    y = np.asarray(y, dtype=np.float32)
    if y.ndim != 1:
        y = np.mean(y, axis=-1).astype(np.float32)
    hop_s = HOP / float(sr)
    rms_db = frame_rms_db(y)

    if mode == "mix":
        src, _ = librosa.effects.hpss(y)
        sos = butter(2, MIX_HIGHPASS_HZ, "highpass", fs=sr, output="sos")
        src = sosfiltfilt(sos, src).astype(np.float32)
        fmin = FMIN_MIX
        beta = MIX_BETA_PARAMETERS
    else:
        src = y
        fmin = FMIN_SEPARATED
        beta = SEPARATED_BETA_PARAMETERS

    with _pyin_lock:
        f0, vflag, vprob = librosa.pyin(
            src, fmin=fmin, fmax=FMAX, sr=sr, frame_length=FRAME, hop_length=HOP, fill_na=0.0,
            beta_parameters=beta,
        )
    f0 = np.nan_to_num(np.asarray(f0, dtype=np.float64), nan=0.0)
    vprob = np.nan_to_num(np.asarray(vprob, dtype=np.float64), nan=0.0)
    if mode == "mix":
        f0 = _fix_sub_octave_by_parity(src, f0, sr)
    n = min(len(f0), len(rms_db))
    f0, vprob, rms_db = f0[:n], vprob[:n], rms_db[:n]

    # threshold a lightly smoothed voiced probability so that it does not flicker
    # around the threshold from frame to frame
    vprob_s = medfilt(vprob, kernel_size=5) if vprob.size >= 5 else vprob
    if mode == "mix":
        level_ok = rms_db > (float(np.median(rms_db)) - 10.0)
        voiced = (f0 > 0) & (vprob_s > 0.5) & level_ok
    else:
        voiced = (f0 > 0) & (vprob_s > 0.35) & (rms_db > -45.0)
    voiced &= (f0 >= fmin * 0.98) & (f0 <= FMAX * 1.02)

    f0 = np.where(voiced, f0, 0.0)
    if mode == "mix":
        f0, voiced = _bridge_short_holes(f0, voiced, max_frames=3)
    f0 = _median_within_runs(f0, voiced, k=5)
    voiced = _remove_short_islands(voiced, MIN_ISLAND_FRAMES)
    f0 = np.where(voiced, f0, 0.0)
    f0 = _fix_octave_jumps(f0, voiced, hop_s)
    f0 = np.where(voiced, f0, 0.0)

    return {
        "hz": f0.astype(np.float64),
        "rmsDb": rms_db.astype(np.float64),
        "t0": 0.0,
        "hop": hop_s,
        "voicedProb": vprob,
    }
