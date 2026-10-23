"""Generate a synthetic 30 s "song" with a known melody for pipeline tests.

The melody is a sawtooth-like harmonic tone (a crude voice) with
  * vibrato on the long notes,
  * a slide (portamento) into one high note,
  * a run of short notes,
  * four phrases separated by breath-sized gaps, each at a different loudness,
over a soft chord-pad accompaniment with a quiet pulse.

Outputs (in the directory given as argv[1], default tests/out):
  song.wav    mix (vocal + accompaniment), 44.1 kHz stereo
  vocal.wav   melody alone (used as the "separated vocal" in tests)
  truth.json  ground-truth notes {start, end, midi, vibrato, slideFrom, run, phrase}
"""

from __future__ import annotations

import json
import os
import sys
from typing import Dict, List

import numpy as np
import soundfile as sf

SR = 44100
DURATION = 30.0
BPM = 100.0
BEAT = 60.0 / BPM

# Phrase definitions: (start time, loudness gain, [(midi, beats, opts), ...])
# opts: v = vibrato, s = slide from N semitones below, legato by default,
#       gap = short silence (s) before the note (< 0.25 s, no phrase split)
PHRASES = [
    (1.0, 0.55, [(60, 1.0, {}), (62, 1.0, {}), (64, 1.0, {}), (65, 0.5, {}), (67, 2.5, {"v": True})]),
    (7.0, 0.80, [(67, 1.0, {}), (69, 1.0, {"gap": 0.1}), (72, 2.5, {"s": 3, "v": True}), (69, 0.5, {}), (67, 1.5, {})]),
    (13.0, 0.40, [(64, 1.0, {}), (65, 0.5, {}), (67, 0.5, {}), (65, 0.5, {}), (64, 0.5, {}), (62, 0.5, {}),
                  (60, 0.5, {}), (62, 2.0, {"v": True})]),
    (18.5, 1.00, [(60, 0.5, {}), (64, 0.5, {}), (67, 0.5, {}),
                  # a run of five short notes
                  (69, 0.2, {}), (67, 0.2, {}), (65, 0.2, {}), (64, 0.2, {}), (62, 0.2, {}),
                  (60, 3.0, {"v": True})]),
]
CHORDS = [  # (start beat, root midi, quality) over a C major progression, 2 bars each
    (0, 48, "maj"), (8, 45, "min"), (16, 53, "maj"), (24, 55, "maj"),
    (32, 48, "maj"), (40, 45, "min"), (48, 53, "maj"), (56, 55, "maj"),
]


def midi_to_hz(m: np.ndarray | float) -> np.ndarray | float:
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=np.float64) - 69.0) / 12.0)


def harmonic_tone(phase: np.ndarray, n_harm: int = 12, tilt: float = 1.2) -> np.ndarray:
    out = np.zeros_like(phase)
    for k in range(1, n_harm + 1):
        out += np.sin(k * phase) / (k ** tilt)
    return out / 1.8


def render_melody() -> tuple[np.ndarray, List[Dict]]:
    n = int(SR * DURATION)
    t = np.arange(n) / SR
    midi_track = np.zeros(n)
    env = np.zeros(n)
    truth: List[Dict] = []
    rng = np.random.default_rng(7)
    for p_idx, (p_start, gain, notes) in enumerate(PHRASES):
        cur = p_start
        prev_midi = None
        for idx, (midi, beats, opts) in enumerate(notes):
            dur = beats * BEAT
            gap = opts.get("gap", 0.0)
            cur += gap
            a, b = int(cur * SR), int((cur + dur) * SR)
            seg_t = t[a:b] - cur
            m = np.full(b - a, float(midi))
            slide_from = None
            if "s" in opts:
                slide_dur = 0.14
                slide_from = midi - opts["s"]
                k = seg_t < slide_dur
                m[k] = slide_from + (midi - slide_from) * (seg_t[k] / slide_dur)
            if opts.get("v"):
                # vibrato ramps in after 0.25 s: 5.5 Hz, +-45 cents (90 cents peak to peak)
                ramp = np.clip((seg_t - 0.25) / 0.3, 0, 1)
                m += 0.45 * ramp * np.sin(2 * np.pi * 5.5 * seg_t)
            # small natural pitch wobble
            m += 0.03 * np.sin(2 * np.pi * 0.7 * seg_t + rng.uniform(0, 6.28))
            midi_track[a:b] = m
            e = np.ones(b - a)
            att = int(0.02 * SR)
            rel = int(0.05 * SR)
            legato_in = prev_midi is not None and gap == 0.0 and "s" not in opts
            if not legato_in:
                e[:att] = np.linspace(0, 1, att)
            is_last = idx == len(notes) - 1
            next_gap = 0.0 if is_last else notes[idx + 1][2].get("gap", 0.0)
            next_slide = (not is_last) and "s" in notes[idx + 1][2]
            if is_last or next_gap > 0 or next_slide:
                e[-rel:] = np.linspace(1, 0, rel)
            # slight swell on long notes
            if dur >= 1.5:
                e *= 0.85 + 0.15 * np.sin(np.pi * np.clip(seg_t / dur, 0, 1))
            env[a:b] = gain * e
            truth.append({
                "start": round(cur, 4), "end": round(cur + dur, 4), "midi": midi,
                "vibrato": bool(opts.get("v", False)), "slideFrom": slide_from,
                "run": beats <= 0.2, "phrase": p_idx,
            })
            prev_midi = midi
            cur += dur
    voiced = env > 0
    hz = np.where(voiced, midi_to_hz(np.where(voiced, midi_track, 60.0)), 0.0)
    phase = np.cumsum(2 * np.pi * hz / SR)
    tone = harmonic_tone(phase) * env
    # a bit of breathiness
    tone += 0.004 * rng.standard_normal(n) * env
    return tone.astype(np.float32), truth


def render_accompaniment() -> np.ndarray:
    """Plucked chords on every beat (decaying, like a guitar/piano) plus a soft bass and pulse."""
    n = int(SR * DURATION)
    out = np.zeros(n)
    rng = np.random.default_rng(3)
    for start_beat, root, quality in CHORDS:
        third = 4 if quality == "maj" else 3
        for beat in range(start_beat, start_beat + 8):
            a = int(beat * BEAT * SR)
            if a >= n:
                break
            dur = min(int(BEAT * 1.1 * SR), n - a)
            seg_t = np.arange(dur) / SR
            env = np.minimum(1.0, seg_t / 0.01) * np.exp(-seg_t * 3.0)
            # strum: slight onset offset per chord tone, a little detune
            for j, m in enumerate((root + 12, root + third + 12, root + 19)):
                f = float(midi_to_hz(m)) * (1 + rng.normal(0, 0.0015))
                off = int(j * 0.012 * SR)
                ph = 2 * np.pi * f * seg_t
                tone = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.15 * np.sin(3 * ph) + 0.08 * np.sin(4 * ph))
                out[a + off:a + dur] += (tone * env * 0.045)[: dur - off]
            # bass note on beats 1 and 3 of the bar
            if beat % 2 == 0:
                fb = float(midi_to_hz(root))
                out[a:a + dur] += np.sin(2 * np.pi * fb * seg_t) * np.exp(-seg_t * 2.5) * 0.12
    # soft pulse on every beat (gives beat_track something to find)
    for k in range(int(DURATION / BEAT)):
        a = int(k * BEAT * SR)
        dur = int(0.08 * SR)
        if a + dur > n:
            break
        seg_t = np.arange(dur) / SR
        out[a:a + dur] += 0.18 * np.sin(2 * np.pi * (55 * np.exp(-seg_t * 20) + 45) * seg_t) * np.exp(-seg_t * 40)
        # hi-hat-ish noise burst on the off beats
        b = a + int(BEAT * SR / 2)
        if b + dur <= n:
            out[b:b + dur] += 0.03 * rng.standard_normal(dur) * np.exp(-seg_t * 60)
    return out.astype(np.float32)


def build(out_dir: str) -> Dict[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    vocal, truth = render_melody()
    acc = render_accompaniment()
    mix = vocal * 0.6 + acc
    peak = float(np.max(np.abs(mix)))
    mix = mix / peak * 0.9
    vocal_out = vocal / peak * 0.9 * 0.6
    stereo = np.stack([mix, mix], axis=1)
    song_path = os.path.join(out_dir, "song.wav")
    vocal_path = os.path.join(out_dir, "vocal.wav")
    truth_path = os.path.join(out_dir, "truth.json")
    sf.write(song_path, stereo, SR, subtype="PCM_16")
    sf.write(vocal_path, vocal_out, SR, subtype="PCM_16")
    with open(truth_path, "w") as f:
        json.dump({"sr": SR, "duration": DURATION, "bpm": BPM, "key": "C major", "notes": truth,
                   "phrases": len(PHRASES)}, f, indent=1)
    return {"song": song_path, "vocal": vocal_path, "truth": truth_path}


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    paths = build(out)
    print(json.dumps(paths, indent=1))
