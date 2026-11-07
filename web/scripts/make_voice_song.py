"""A more voice-like synthetic test song: glottal pulse train through vowel formant filters, with vibrato,
breath noise, a slide and a run, over a chord + drum backing. Usage: python3 -I make_voice_song.py OUT_DIR"""
import sys, os, wave
import numpy as np
from scipy.signal import lfilter

SR = 44100
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(1)

def midi_hz(m):
    return 440 * 2 ** ((m - 69) / 12)

def formant(sig, f, bw):
    r = np.exp(-np.pi * bw / SR)
    a = [1, -2 * r * np.cos(2 * np.pi * f / SR), r * r]
    return lfilter([1 - r], a, sig)

VOWELS = {'a': [(730, 90), (1090, 110), (2440, 160)], 'i': [(270, 60), (2290, 120), (3010, 180)], 'o': [(570, 80), (840, 100), (2410, 160)], 'e': [(530, 70), (1840, 110), (2480, 160)]}
phrases = [
    [(60, 0.5, 'a'), (62, 0.5, 'e'), (64, 0.5, 'i'), (65, 0.5, 'o'), (67, 1.4, 'a')],
    [(67, 0.4, 'o'), (69, 0.4, 'a'), (72, 1.6, 'a', 69), (71, 0.5, 'e'), (69, 0.9, 'o')],
    [(64, 0.3, 'i'), (65, 0.3, 'i'), (67, 0.3, 'e'), (69, 0.3, 'e'), (67, 0.6, 'a'), (64, 1.2, 'o')],
    [(72, 0.7, 'a'), (71, 0.5, 'a'), (69, 0.5, 'e'), (67, 0.5, 'e'), (65, 0.5, 'o'), (64, 1.8, 'a')],
]
notes = []
t = 1.0
for ph in phrases:
    for spec in ph:
        m, d, v = spec[0], spec[1], spec[2]
        slide = spec[3] if len(spec) > 3 else None
        notes.append((m, t, t + d, v, slide, d >= 1.2))
        t += d
    t += 0.6
dur = t + 1.0
n = int(dur * SR)
tt = np.arange(n) / SR
voice = np.zeros(n)
for (m, a, b, v, slide, vib) in notes:
    i0, i1 = int(a * SR), int(b * SR)
    seg = tt[i0:i1] - a
    midi = np.full(seg.shape, float(m))
    if slide is not None:
        midi = slide + (m - slide) * np.clip(seg / 0.15, 0, 1)
    if vib:
        midi = midi + 0.25 * np.sin(2 * np.pi * 5.5 * seg) * np.clip((seg - 0.3) / 0.3, 0, 1)
    midi = midi + 0.03 * np.sin(2 * np.pi * 0.7 * seg)  # slow drift, human-like
    f = midi_hz(midi)
    phase = np.cumsum(f / SR) % 1.0
    # glottal-ish pulse train: narrow raised-cosine pulses with some jitter → rich harmonics
    pulse = np.clip(1 - (phase / 0.12), 0, 1) ** 2
    src = pulse - pulse.mean()
    src = src + 0.02 * rng.standard_normal(seg.shape)  # aspiration noise
    y = np.zeros_like(src)
    for (ff, bw) in VOWELS[v]:
        y += formant(src, ff, bw)
    y = formant(y, 3300, 250) * 0.3 + y
    env = np.minimum(1, seg / 0.04) * np.minimum(1, (b - a - seg) / 0.08)
    loud = 1.0 if m >= 71 else 0.7
    y = y / (np.max(np.abs(y)) + 1e-9)
    voice[i0:i1] += y * env * loud * 0.5
# backing: plucked chords (decaying) + bass + kick/hat
back = np.zeros(n)
prog = [(48, 52, 55), (53, 57, 60), (55, 59, 62), (48, 52, 55)]
bar = dur / len(prog)
for k, ch in enumerate(prog):
    for beat in np.arange(k * bar, (k + 1) * bar, 0.5):
        i0 = int(beat * SR); seg = np.arange(0, int(0.45 * SR)) / SR
        for m in ch:
            tone = (np.sin(2 * np.pi * midi_hz(m) * seg) + 0.4 * np.sin(2 * np.pi * midi_hz(m) * 2 * seg) + 0.2 * np.sin(2 * np.pi * midi_hz(m) * 3 * seg)) * np.exp(-seg * 6)
            back[i0:i0 + len(seg)] += 0.06 * tone[: n - i0]
    i0, i1 = int(k * bar * SR), int(min(n, (k + 1) * bar * SR))
    back[i0:i1] += 0.12 * np.sin(2 * np.pi * midi_hz(ch[0] - 12) * tt[i0:i1])
for b in np.arange(0, dur, 0.5):
    i0 = int(b * SR); seg = np.arange(0, int(0.12 * SR)) / SR
    kick = np.sin(2 * np.pi * (60 + 80 * np.exp(-seg * 30)) * seg) * np.exp(-seg * 25)
    back[i0:i0 + len(kick)] += 0.3 * kick[: n - i0]
    hat = rng.standard_normal(int(0.03 * SR)) * np.exp(-np.arange(int(0.03 * SR)) / SR * 150)
    j0 = int((b + 0.25) * SR); back[j0:j0 + len(hat)] += 0.05 * hat[: n - j0]
song = voice + back
song = song / np.max(np.abs(song)) * 0.9
voice_only = voice / (np.max(np.abs(voice)) + 1e-9) * 0.6

def write(path, x, stereo=False):
    x16 = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2 if stereo else 1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(np.stack([x16, x16], axis=1).tobytes() if stereo else x16.tobytes())

write(os.path.join(out, 'voice-song.wav'), song, stereo=True)
write(os.path.join(out, 'voice-only.wav'), voice_only)
with open(os.path.join(out, 'voice-notes.txt'), 'w') as f:
    for (m, a, b, v, slide, vib) in notes:
        f.write(f"{m} {a:.2f} {b:.2f} {slide} {vib}\n")
print(f"wrote {dur:.1f}s voice-like song, {len(notes)} notes")
