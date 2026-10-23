"""Generate synthetic test audio: a 'song' (melody + chords) and a 'voice' (melody only) WAV.
Usage: python3 -I make_test_audio.py OUT_DIR
"""
import sys, wave, struct, math, os
import numpy as np

SR = 44100
out = sys.argv[1]
os.makedirs(out, exist_ok=True)

def midi_hz(m):
    return 440 * 2 ** ((m - 69) / 12)

# phrase structure: (midi, start, end, slide_from, vibrato)
notes = []
t = 1.0
phrases = [
    [(60, 0.5), (62, 0.5), (64, 0.5), (65, 0.5), (67, 1.4)],
    [(67, 0.4), (69, 0.4), (72, 1.6, 69), (71, 0.5), (69, 0.9)],
    [(64, 0.3), (65, 0.3), (67, 0.3), (69, 0.3), (67, 0.6), (64, 1.2)],
    [(72, 0.7), (71, 0.5), (69, 0.5), (67, 0.5), (65, 0.5), (64, 1.8)],
]
for ph in phrases:
    for spec in ph:
        m, d = spec[0], spec[1]
        slide = spec[2] if len(spec) > 2 else None
        notes.append((m, t, t + d, slide, d >= 1.2))
        t += d
    t += 0.6  # breath
dur = t + 1.0
n = int(dur * SR)
tt = np.arange(n) / SR
voice = np.zeros(n)
for (m, a, b, slide, vib) in notes:
    i0, i1 = int(a * SR), int(b * SR)
    seg = tt[i0:i1] - a
    midi = np.full(seg.shape, float(m))
    if slide is not None:
        g = np.clip(seg / 0.15, 0, 1)
        midi = slide + (m - slide) * g
    if vib:
        midi = midi + 0.25 * np.sin(2 * np.pi * 5.5 * seg) * np.clip((seg - 0.3) / 0.3, 0, 1)
    f = midi_hz(midi)
    phase = np.cumsum(2 * np.pi * f / SR)
    # vowel-like harmonic stack
    s = np.zeros_like(seg)
    for h, amp in [(1, 1.0), (2, 0.5), (3, 0.35), (4, 0.2), (5, 0.12), (6, 0.08)]:
        s += amp * np.sin(h * phase)
    env = np.minimum(1, seg / 0.03) * np.minimum(1, (b - a - seg) / 0.06)
    loud = 1.0 if m >= 71 else 0.6
    voice[i0:i1] += s * env * loud * 0.18

# chords: root + fifth + third, sustained pads, low level
chords = np.zeros(n)
prog = [(48, 52, 55), (53, 57, 60), (55, 59, 62), (48, 52, 55)]
bar = dur / len(prog)
for k, ch in enumerate(prog):
    i0, i1 = int(k * bar * SR), int(min(n, (k + 1) * bar * SR))
    seg = tt[i0:i1]
    for m in ch:
        chords[i0:i1] += 0.05 * np.sin(2 * np.pi * midi_hz(m) * seg) + 0.02 * np.sin(2 * np.pi * midi_hz(m) * 2 * seg)
# simple kick on beats
kick = np.zeros(n)
for b in np.arange(0, dur, 0.5):
    i0 = int(b * SR)
    seg = np.arange(0, int(0.12 * SR)) / SR
    k = np.sin(2 * np.pi * (60 + 80 * np.exp(-seg * 30)) * seg) * np.exp(-seg * 25)
    kick[i0:i0 + len(k)] += 0.25 * k[: n - i0]

song = voice + chords + kick
song = song / np.max(np.abs(song)) * 0.9
voice_only = voice / max(1e-6, np.max(np.abs(voice))) * 0.6

def write(path, x, stereo=False):
    x16 = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2 if stereo else 1)
        w.setsampwidth(2)
        w.setframerate(SR)
        data = np.stack([x16, x16], axis=1).tobytes() if stereo else x16.tobytes()
        w.writeframes(data)

write(os.path.join(out, 'test-song.wav'), song, stereo=True)
write(os.path.join(out, 'test-voice.wav'), voice_only)
with open(os.path.join(out, 'notes.txt'), 'w') as f:
    for (m, a, b, slide, vib) in notes:
        f.write(f"{m} {a:.2f} {b:.2f} {slide} {vib}\n")
print(f"wrote {dur:.1f}s song with {len(notes)} notes in {len(phrases)} phrases to {out}")
