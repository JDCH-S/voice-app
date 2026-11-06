// Voice-quality formulas shared by the live analyser (MicAnalyzer) and the self-tests.
// Everything here is pure arithmetic on numbers the pitch worklet measures per window:
// the YIN aperiodicity d' of the chosen pitch candidate, the mean power of six octave bands
// and the spectral centroid. Keep it dependency-free: the worklet cannot import modules, so
// it only ships measurements, and these functions turn them into the PitchFrame fields.

/** Octave bands (Hz) whose mean power the worklet reports, lowest first. */
export const TILT_BANDS: ReadonlyArray<readonly [number, number]> = [
  [100, 200],
  [200, 400],
  [400, 800],
  [800, 1600],
  [1600, 3200],
  [3200, 6400],
];

export const HNR_MIN_DB = -10;
export const HNR_MAX_DB = 40;

/** Default top of range (MIDI) used by `pressedIndex` until the singer's range is known: roughly D5. */
export const DEFAULT_HIGH_MIDI = 74;
/** Default singing level (dBFS) used by `pressedIndex` until the microphone has been calibrated. */
export const DEFAULT_REFERENCE_DB = -25;

export interface PressedInput {
  tilt: number; // dB/octave (negative)
  db: number; // frame level in dBFS
  midi: number; // sung pitch (NaN/undefined when unvoiced)
  hnr: number; // dB
}

export interface PressedContext {
  highMidi?: number; // top of the singer's comfortable range
  referenceDb?: number; // the singer's normal singing level in dBFS
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Harmonics-to-noise ratio in dB from the YIN cumulative-mean-normalised difference at the chosen
 * period (d' ≈ aperiodic / periodic energy): HNR ≈ 10·log10((1 − d′) / d′). Clamped to −10..40 dB.
 */
export function hnrFromAperiodicity(dPrime: number): number {
  if (!(dPrime >= 0) || dPrime !== dPrime) return HNR_MIN_DB;
  if (dPrime <= 1e-4) return HNR_MAX_DB;
  const d = Math.min(0.9999, dPrime);
  const hnr = 10 * Math.log10((1 - d) / d);
  return Math.max(HNR_MIN_DB, Math.min(HNR_MAX_DB, hnr));
}

/**
 * Spectral tilt in dB per octave: the least-squares slope of band mean power (dB) against octave
 * index, for the `TILT_BANDS` octave bands. A flat spectrum gives 0, a sawtooth about −6, a modal
 * singing voice about −9 to −12, a breathy voice −15 or steeper, a pressed voice −6 or brighter.
 * Bands with no energy (≤ −120 dB) are ignored, and so are bands that lie entirely below the
 * fundamental `f0Hz` when it is known (they hold only leakage and would read as "bright").
 * Fewer than 3 usable bands return −12 (neutral).
 */
export function tiltFromBands(bandsDb: ArrayLike<number>, f0Hz = 0): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < bandsDb.length; i++) {
    const y = bandsDb[i];
    if (!(y > -120)) continue;
    if (f0Hz > 0 && i < TILT_BANDS.length && TILT_BANDS[i][1] < f0Hz) continue;
    n++;
    sx += i;
    sy += y;
    sxx += i * i;
    sxy += i * y;
  }
  if (n < 3) return -12;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return -12;
  const slope = (n * sxy - sx * sy) / denom;
  return Math.max(-40, Math.min(20, slope));
}

/**
 * Mean power (dB) of each octave band of a magnitude spectrum, as the worklet computes it.
 * `power[k]` is |X[k]|² for bin k, `binHz` the bin spacing. Pure, so the self-test can run the
 * same code on synthesised spectra.
 */
export function bandPowersDb(power: ArrayLike<number>, binHz: number): number[] {
  const out: number[] = [];
  for (const [lo, hi] of TILT_BANDS) {
    const k0 = Math.max(1, Math.ceil(lo / binHz));
    const k1 = Math.min(power.length - 1, Math.floor(hi / binHz));
    if (k1 < k0) {
      out.push(-200);
      continue;
    }
    let s = 0;
    for (let k = k0; k <= k1; k++) s += power[k];
    const meanP = s / (k1 - k0 + 1);
    out.push(meanP > 1e-20 ? 10 * Math.log10(meanP) : -200);
  }
  return out;
}

/** Spectral centroid (Hz) of a power spectrum between `fLo` and `fHi`. 0 when there is no energy. */
export function spectralCentroid(power: ArrayLike<number>, binHz: number, fLo = 60, fHi = 8000): number {
  const k0 = Math.max(1, Math.ceil(fLo / binHz));
  const k1 = Math.min(power.length - 1, Math.floor(fHi / binHz));
  let num = 0;
  let den = 0;
  for (let k = k0; k <= k1; k++) {
    num += k * binHz * power[k];
    den += power[k];
  }
  return den > 0 ? num / den : 0;
}

/**
 * Breathiness 0..1: mostly low HNR (15 dB → 0, 3 dB → 1), a little steep spectral tilt
 * (−12 dB/oct → 0, −20 → 1). Clear voice ≈ 0.1, audible air ≈ 0.5, whispery ≈ 0.9.
 */
export function breathinessIndex(hnr: number, tilt: number): number {
  const fromHnr = clamp01((15 - hnr) / 12);
  const fromTilt = clamp01((-tilt - 12) / 8);
  return clamp01(0.7 * fromHnr + 0.3 * fromTilt);
}

/**
 * Pressed / strain index 0..1. Pressed phonation is bright (shallow tilt), loud and happens
 * near the top of the range, with a clear (high-HNR) tone. Brightness is necessary: the level
 * and pitch terms scale it. Noise-like frames (low HNR) cannot be "pressed".
 */
export function pressedIndex(input: PressedInput, ctx: PressedContext = {}): number {
  const highMidi = ctx.highMidi ?? DEFAULT_HIGH_MIDI;
  const refDb = ctx.referenceDb ?? DEFAULT_REFERENCE_DB;
  const bright = clamp01((input.tilt + 12) / 8); // −12 → 0, −4 → 1
  const loud = clamp01((input.db - refDb) / 10); // at the normal level → 0, +10 dB → 1
  const midi = input.midi;
  const highPitch = midi === midi && midi !== undefined ? clamp01((midi - (highMidi - 5)) / 5) : 0;
  const clear = clamp01((input.hnr - 4) / 8); // breathy noise is not pressed
  return clamp01(bright * (0.4 + 0.35 * loud + 0.25 * highPitch) * clear);
}

/** All per-frame voice-quality fields from the worklet's measurements for one frame. */
export function voiceQualityFor(
  m: { dPrime: number; bandsDb: ArrayLike<number>; centroid: number; db: number; midi: number; hz?: number },
  ctx: PressedContext = {},
): { hnr: number; tilt: number; centroid: number; breathiness: number; pressed: number } {
  const hnr = hnrFromAperiodicity(m.dPrime);
  const tilt = tiltFromBands(m.bandsDb, m.hz ?? 0);
  const breathiness = breathinessIndex(hnr, tilt);
  const pressed = pressedIndex({ tilt, db: m.db, midi: m.midi, hnr }, ctx);
  return { hnr, tilt, centroid: m.centroid, breathiness, pressed };
}
