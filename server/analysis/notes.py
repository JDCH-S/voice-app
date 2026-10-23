"""Note segmentation and per-note features (RefNote in docs/ANALYSIS_SCHEMA.md).

Pipeline for every continuous voiced run of the melody track:

1. glide regions: frames where the (smoothed) pitch moves monotonically-ish;
   a region that spans >= 1.5 semitones over >= 60 ms is a *slide*.  Slide
   frames are not part of any note; the note that follows gets `slideIn`.
2. the stable stretches between slides are segmented into notes where the
   smoothed MIDI pitch leaves the running median of the current note by
   > 0.5 semitone for >= 3 consecutive frames (~35 ms).
3. adjacent segments closer than 0.5 semitone are re-joined (vibrato splits),
   segments shorter than 60 ms are merged into the neighbour with the closer
   pitch (or dropped when they have no neighbour).
4. per-note features: midi/cents/hzMedian, stability, vibrato, loudness,
   dynamic, register (separated mode only), run flag.

`breathBefore` and `phrase` are filled in by analysis.phrases.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np

from .melody import FRAME, hz_to_midi, voiced_runs

# segmentation
SEG_DEVIATION_ST = 0.5
SEG_MIN_FRAMES = 3
MIN_NOTE_S = 0.060
REF_WINDOW_FRAMES = 172          # ~2 s running-median window for the note reference
# glides
GLIDE_LOCAL_HALF = 3             # +-3 frames (~80 ms) window for the "moving" test
GLIDE_LOCAL_RANGE_ST = 0.6
SLIDE_MIN_ST = 1.5
SLIDE_MIN_S = 0.060
# runs
RUN_MAX_NOTE_S = 0.180
RUN_MAX_GAP_S = 0.080
RUN_STEP_ST = 2.0
RUN_MIN_NOTES = 3
# vibrato
VIB_MIN_NOTE_S = 0.35
VIB_RATE_LO, VIB_RATE_HI = 4.0, 8.0
VIB_MIN_EXTENT_CENTS = 20.0
VIB_MIN_CYCLES = 2.0
# core trimming
CORE_TRIM = 0.15


def _smooth(m: np.ndarray) -> np.ndarray:
    """3-point moving average (the hz track is already median filtered)."""
    if m.size < 3:
        return m.copy()
    out = m.copy()
    out[1:-1] = (m[:-2] + m[1:-1] + m[2:]) / 3.0
    return out


def _glide_regions(m: np.ndarray, hop: float) -> List[Tuple[int, int, float]]:
    """Slide regions [(a, b_exclusive, from_pitch)] within one voiced run (local indices).

    A region qualifies when the pitch moves monotonically-ish across >= 1.5 st and
    the *interior* frames (strictly between the two levels) last >= 60 ms. pyin's
    93 ms analysis window smears a plain step over 2-4 frames, which is why only
    interior frames count; a plateau inside the region means an intermediate note
    (a staircase / run), not a glide.
    """
    n = m.size
    if n < 2 * GLIDE_LOCAL_HALF + 2:
        return []
    h = GLIDE_LOCAL_HALF
    moving = np.zeros(n, dtype=np.int8)
    for i in range(n):
        a, b = max(0, i - h), min(n, i + h + 1)
        w = m[a:b]
        rng = float(w.max() - w.min())
        if rng < GLIDE_LOCAL_RANGE_ST:
            continue
        disp = float(m[b - 1] - m[a])
        if abs(disp) >= 0.8 * rng:
            moving[i] = 1 if disp > 0 else -1
    min_interior = int(np.ceil(SLIDE_MIN_S / hop))
    regions: List[Tuple[int, int, float]] = []
    i = 0
    while i < n:
        if moving[i] == 0:
            i += 1
            continue
        sgn = moving[i]
        j = i
        while j < n and moving[j] == sgn:
            j += 1
        seg = m[i:j]
        lo, hi = float(seg.min()), float(seg.max())
        span = hi - lo
        if span >= SLIDE_MIN_ST:
            interior = (seg > lo + 0.08 * span) & (seg < hi - 0.08 * span)
            idx = np.flatnonzero(interior)
            if idx.size >= min_interior:
                a_in, b_in = i + int(idx[0]), i + int(idx[-1]) + 1
                inner = m[a_in:b_in]
                # longest plateau inside the glide (consecutive frames within 0.15 st)
                plateau = best = 1
                for k in range(1, inner.size):
                    plateau = plateau + 1 if abs(inner[k] - inner[k - 1]) < 0.15 else 1
                    best = max(best, plateau)
                a_g, b_g = max(i, a_in - 1), min(j, b_in + 1)
                total_var = float(np.sum(np.abs(np.diff(m[a_g:b_g]))))
                net = abs(float(m[b_g - 1] - m[a_g]))
                monotonic = total_var <= 1.35 * net + 0.3
                if best < 5 and net >= SLIDE_MIN_ST and monotonic:
                    regions.append((a_g, b_g, float(m[a_g])))
        i = j
    return regions


def _segment_stable(m: np.ndarray, a: int, b: int) -> List[Tuple[int, int]]:
    """Spec rule: new note when pitch leaves the running median by > 0.5 st for >= 3 frames."""
    segs: List[Tuple[int, int]] = []
    if b - a <= 0:
        return segs
    cur = a
    dev = 0
    i = a + 1
    while i < b:
        ref = float(np.median(m[max(cur, i - REF_WINDOW_FRAMES):i]))
        if abs(m[i] - ref) > SEG_DEVIATION_ST:
            dev += 1
        else:
            dev = 0
        if dev >= SEG_MIN_FRAMES:
            new_start = i - (SEG_MIN_FRAMES - 1)
            if new_start > cur:
                segs.append((cur, new_start))
            cur = new_start
            dev = 0
        i += 1
    segs.append((cur, b))
    return segs


def _merge_segments(segs: List[Tuple[int, int]], m: np.ndarray, hop: float) -> List[Tuple[int, int]]:
    """Join near-equal neighbours, then absorb segments < 60 ms into the closer-pitched neighbour."""
    segs = [s for s in segs if s[1] > s[0]]
    if not segs:
        return segs
    # 1) re-join adjacent segments whose medians differ by < 0.5 st (vibrato splits)
    joined: List[Tuple[int, int]] = [segs[0]]
    for s in segs[1:]:
        p = joined[-1]
        if abs(np.median(m[p[0]:p[1]]) - np.median(m[s[0]:s[1]])) < SEG_DEVIATION_ST:
            joined[-1] = (p[0], s[1])
        else:
            joined.append(s)
    segs = joined
    # 2) merge short segments
    min_frames = int(np.ceil(MIN_NOTE_S / hop))
    while True:
        lengths = [e - s for s, e in segs]
        short = [i for i, L in enumerate(lengths) if L < min_frames]
        if not short:
            break
        i = min(short, key=lambda k: lengths[k])
        s, e = segs[i]
        if len(segs) == 1:
            return []
        med = float(np.median(m[s:e]))
        cands = []
        if i > 0:
            ps, pe = segs[i - 1]
            cands.append((abs(med - float(np.median(m[ps:pe]))), i - 1))
        if i < len(segs) - 1:
            ns, ne = segs[i + 1]
            cands.append((abs(med - float(np.median(m[ns:ne]))), i + 1))
        _, j = min(cands)
        if j < i:
            segs[j] = (segs[j][0], e)
        else:
            segs[j] = (s, segs[j][1])
        del segs[i]
    return segs


def _core(fs: int, fe: int) -> Tuple[int, int]:
    n = fe - fs
    trim = int(np.floor(CORE_TRIM * n))
    c0, c1 = fs + trim, fe - trim
    if c1 - c0 < min(n, 3):
        c0, c1 = fs, fe
    return c0, c1


def _detrend(x: np.ndarray) -> np.ndarray:
    if x.size < 4:
        return x - np.mean(x)
    t = np.arange(x.size, dtype=np.float64)
    coef = np.polyfit(t, x, 1)
    return x - np.polyval(coef, t)


def _vibrato(cents: np.ndarray, hop: float) -> Optional[Dict[str, float]]:
    """Periodic 4-8 Hz modulation with peak-to-peak extent >= 20 cents."""
    n = cents.size
    dur = n * hop
    if dur < VIB_MIN_NOTE_S or n < 16:
        return None
    x = _detrend(cents.astype(np.float64))
    # remove slow wander (> 0.5 s) so that scoops/decays do not dominate the spectrum
    k = int(round(0.5 / hop)) | 1
    if n > k:
        kern = np.ones(k) / k
        slow = np.convolve(np.pad(x, (k // 2, k // 2), mode="edge"), kern, mode="valid")
        x = x - slow[:n]
    if np.std(x) < 3.0:
        return None
    fs = 1.0 / hop
    nfft = 1 << max(12, int(np.ceil(np.log2(n * 8))))
    win = np.hanning(n)
    spec = np.abs(np.fft.rfft(x * win, nfft)) ** 2
    freqs = np.fft.rfftfreq(nfft, d=hop)
    band = (freqs >= 1.5) & (freqs <= 15.0)
    if not np.any(band):
        return None
    bidx = np.flatnonzero(band)
    peak = bidx[int(np.argmax(spec[bidx]))]
    rate = float(freqs[peak])
    if not (VIB_RATE_LO <= rate <= VIB_RATE_HI):
        return None
    prominence = spec[peak] / max(float(np.median(spec[bidx])), 1e-12)
    if prominence < 4.0 or dur * rate < VIB_MIN_CYCLES:
        return None
    # amplitude by least squares fit of a sinusoid at the detected rate
    t = np.arange(n) * hop
    A = np.column_stack([np.sin(2 * np.pi * rate * t), np.cos(2 * np.pi * rate * t)])
    coef, *_ = np.linalg.lstsq(A, x, rcond=None)
    amp = float(np.hypot(coef[0], coef[1]))
    fit = A @ coef
    r2 = 1.0 - float(np.sum((x - fit) ** 2)) / max(float(np.sum(x ** 2)), 1e-9)
    extent = 2.0 * amp
    if extent < VIB_MIN_EXTENT_CENTS or r2 < 0.15:
        return None
    return {"rate": round(rate, 2), "extentCents": round(extent, 1)}


def dynamic_label(loudness_db: float) -> str:
    if loudness_db >= -3:
        return "ff"
    if loudness_db >= -7:
        return "f"
    if loudness_db >= -12:
        return "mf"
    if loudness_db >= -18:
        return "mp"
    if loudness_db >= -26:
        return "p"
    return "pp"


def _register(y: np.ndarray, sr: int, hop_frames: int, hz_frames: np.ndarray, frame_idx: np.ndarray,
              midi: int) -> Optional[str]:
    """Energy of harmonics 1-2 vs 3-8 around the note's f0 (separated vocal only)."""
    if frame_idx.size < 3:
        return None
    n_fft = FRAME
    win = np.hanning(n_fft).astype(np.float32)
    bin_hz = sr / n_fft
    e12 = 0.0
    e38 = 0.0
    frames = []
    for i in frame_idx:
        c = i * hop_frames
        a, b = c - n_fft // 2, c + n_fft // 2
        if a < 0 or b > y.size:
            continue
        frames.append(y[a:b] * win)
    if len(frames) < 3:
        return None
    mag2 = np.abs(np.fft.rfft(np.stack(frames), axis=1)) ** 2
    for row, i in zip(mag2, frame_idx[: len(frames)]):
        f0 = hz_frames[i]
        if f0 <= 0:
            continue
        for k in range(1, 9):
            bc = int(round(k * f0 / bin_hz))
            if bc + 1 >= row.size:
                break
            e = float(np.sum(row[max(0, bc - 1):bc + 2]))
            if k <= 2:
                e12 += e
            else:
                e38 += e
    if e12 + e38 <= 1e-9:
        return None
    ratio_db = 10.0 * np.log10((e12 + 1e-12) / (e38 + 1e-12))
    if ratio_db >= 12.0 and midi >= 64:
        return "head"
    if ratio_db <= 4.0:
        return "chest"
    if ratio_db > 4.0:
        return "mixed"
    return None


def segment_notes(melody: Dict, *, mode: str = "mix", y: Optional[np.ndarray] = None,
                  sr: int = 22050) -> List[Dict]:
    """Build the RefNote list (without breathBefore/phrase) from a melody track."""
    hz = np.asarray(melody["hz"], dtype=np.float64)
    rms_db = np.asarray(melody["rmsDb"], dtype=np.float64)
    hop = float(melody["hop"])
    t0 = float(melody.get("t0", 0.0))
    hop_samples = int(round(hop * sr))
    midi_f = hz_to_midi(hz)
    voiced = hz > 0

    raw: List[Dict] = []  # dicts with frame bounds, run id, slide info
    for run_id, (s, e) in enumerate(voiced_runs(voiced)):
        m = _smooth(midi_f[s:e])
        glides = _glide_regions(m, hop)
        # stable stretches between glides
        bounds = [0]
        for a, b, _ in glides:
            bounds += [a, b]
        bounds.append(e - s)
        stretches = [(bounds[i], bounds[i + 1]) for i in range(0, len(bounds), 2)]
        pending_slide: Optional[Tuple[int, int, float]] = None
        for k, (a, b) in enumerate(stretches):
            segs = _merge_segments(_segment_stable(m, a, b), m, hop) if b > a else []
            for j, (ss, se) in enumerate(segs):
                note = {"_fs": s + ss, "_fe": s + se, "_run": run_id, "_slide": None}
                if j == 0 and pending_slide is not None:
                    note["_slide"] = pending_slide
                raw.append(note)
            pending_slide = glides[k] if k < len(glides) else None
            if pending_slide is not None:
                pending_slide = (s + pending_slide[0], s + pending_slide[1], pending_slide[2])

    raw.sort(key=lambda d: d["_fs"])
    if not raw:
        return []

    # per-note features
    notes: List[Dict] = []
    for d in raw:
        fs, fe = d["_fs"], d["_fe"]
        c0, c1 = _core(fs, fe)
        core_midi = midi_f[c0:c1]
        med_midi = float(np.median(core_midi))
        midi = int(round(med_midi))
        cents = float((med_midi - midi) * 100.0)
        cents = max(-50.0, min(50.0, cents))
        core_cents = (core_midi - midi) * 100.0
        stability = float(np.std(_detrend(core_cents))) if core_cents.size >= 2 else 0.0
        note_cents = (midi_f[fs:fe] - midi) * 100.0
        vib = _vibrato(note_cents, hop)
        loud_raw = float(np.mean(rms_db[fs:fe]))
        start = t0 + max(0.0, (fs - 0.5) * hop)
        end = t0 + (fe - 0.5) * hop
        slide = None
        if d["_slide"] is not None:
            ga, gb, from_pitch = d["_slide"]
            slide = {"fromMidi": round(float(from_pitch), 2), "duration": round((gb - ga) * hop, 3)}
        register = None
        if mode == "separated" and y is not None:
            register = _register(y, sr, hop_samples, hz, np.arange(c0, c1), midi)
        notes.append({
            "id": 0,
            "start": round(start, 4),
            "end": round(end, 4),
            "midi": midi,
            "cents": round(cents, 1),
            "hzMedian": round(float(np.median(hz[c0:c1])), 2),
            "stabilityCents": round(stability, 1),
            "slideIn": slide,
            "run": False,
            "vibrato": vib,
            "loudnessDb": loud_raw,  # made relative below
            "dynamic": "mf",
            "breathBefore": False,
            "register": register,
            "lyric": None,
            "phrase": 0,
            "_run": d["_run"],
            "_fs": fs,
            "_fe": fe,
        })

    # slideIn.fromMidi: prefer the previous note's midi when the glide starts there
    for i in range(1, len(notes)):
        sl = notes[i]["slideIn"]
        if sl and notes[i - 1]["_run"] == notes[i]["_run"]:
            if abs(sl["fromMidi"] - notes[i - 1]["midi"]) <= 1.0:
                sl["fromMidi"] = notes[i - 1]["midi"]

    # loudness relative to the loudest note
    loudest = max(n["loudnessDb"] for n in notes)
    for n in notes:
        n["loudnessDb"] = round(float(n["loudnessDb"] - loudest), 1)
        n["dynamic"] = dynamic_label(n["loudnessDb"])

    _flag_runs(notes)

    for i, n in enumerate(notes):
        n["id"] = i
        n.pop("_run", None)
    return notes


MIX_PRUNE_QUIET_DB = -12.0
MIX_PRUNE_BELOW_ST = 12.0


def prune_mix_outliers(notes: List[Dict]) -> Tuple[List[Dict], List[Tuple[int, int]]]:
    """Mix mode only: drop quiet notes more than an octave below the sung range.

    pyin on a full mix picks up bass / chord roots in the gaps between sung
    phrases. Those are much quieter than the vocal notes and far below them, so
    notes that are >= 12 dB under the loudest note *and* > 12 st below the 10th
    percentile of the louder notes are treated as instrument pickup.
    Returns (kept_notes, [(frame_start, frame_end) of pruned notes]).
    """
    loud = [n for n in notes if n["loudnessDb"] >= MIX_PRUNE_QUIET_DB]
    if len(loud) < 3:
        return notes, []
    floor = float(np.percentile([n["midi"] for n in loud], 10)) - MIX_PRUNE_BELOW_ST
    kept, pruned = [], []
    for n in notes:
        if n["loudnessDb"] < MIX_PRUNE_QUIET_DB and n["midi"] < floor:
            pruned.append((n["_fs"], n["_fe"]))
        else:
            kept.append(n)
    if pruned:
        for n in kept:
            n["run"] = False
        _flag_runs(kept)
        for i, n in enumerate(kept):
            n["id"] = i
    return kept, pruned


def strip_private(notes: List[Dict]) -> List[Dict]:
    for n in notes:
        for k in ("_fs", "_fe", "_run"):
            n.pop(k, None)
    return notes


def _flag_runs(notes: List[Dict]) -> None:
    """>= 3 consecutive short notes (< 180 ms, tiny gaps) with mostly stepwise intervals."""
    i = 0
    n = len(notes)
    while i < n:
        if notes[i]["end"] - notes[i]["start"] >= RUN_MAX_NOTE_S:
            i += 1
            continue
        j = i
        while (j + 1 < n and notes[j + 1]["end"] - notes[j + 1]["start"] < RUN_MAX_NOTE_S
               and notes[j + 1]["start"] - notes[j]["end"] <= RUN_MAX_GAP_S):
            j += 1
        count = j - i + 1
        if count >= RUN_MIN_NOTES:
            steps = [abs(notes[k + 1]["midi"] - notes[k]["midi"]) for k in range(i, j)]
            stepwise = sum(1 for s in steps if s <= RUN_STEP_ST)
            if stepwise >= np.ceil(2 * len(steps) / 3):
                for k in range(i, j + 1):
                    notes[k]["run"] = True
        i = j + 1
