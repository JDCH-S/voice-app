// Offline melody extraction for the browser fallback: YIN over the (mono) mix with
// harmonic-salience candidate selection so the voice wins over chord pads and bass.
// Returns frame-wise f0 (0 when unvoiced) and RMS in dB.

/** 2nd-order Butterworth high-pass (in place). */
export function highpass(x: Float32Array, sr: number, fc: number) {
  const w0 = (2 * Math.PI * fc) / sr;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * Math.SQRT1_2 * 2);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** Goertzel power at frequency f over the (Hann-windowed) frame. */
function goertzel(x: Float32Array, off: number, W: number, win: Float32Array, f: number, sr: number): number {
  const k = (2 * Math.PI * f) / sr;
  const coeff = 2 * Math.cos(k);
  let s0 = 0,
    s1 = 0,
    s2 = 0;
  for (let i = 0; i < W; i++) {
    s0 = x[off + i] * win[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

export function harmonicEnergy(x: Float32Array, off: number, W: number, win: Float32Array, f0: number, sr: number, harmonics: number[]): number {
  let e = 0;
  for (const h of harmonics) {
    const f = f0 * h;
    if (f > sr / 2 - 100) break;
    e += goertzel(x, off, W, win, f, sr) / h;
  }
  return e;
}

/** Unweighted sum of spectral power at the given harmonics of f0. */
export function seriesEnergy(x: Float32Array, off: number, W: number, win: Float32Array, f0: number, sr: number, harmonics: number[]): number {
  let e = 0;
  for (const h of harmonics) {
    const f = f0 * h;
    if (f > sr / 2 - 100) break;
    e += goertzel(x, off, W, win, f, sr);
  }
  return e;
}

interface Cand {
  tau: number;
  val: number;
}

export function yinCandidates(x: Float32Array, off: number, W: number, sr: number, fmin: number, fmax: number, d: Float32Array): Cand[] {
  const half = W >> 1;
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(half, Math.ceil(sr / fmin));
  let running = 0;
  d[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let acc = 0;
    for (let i = 0; i < half; i++) {
      const diff = x[off + i] - x[off + i + tau];
      acc += diff * diff;
    }
    running += acc;
    d[tau] = running > 0 ? (acc * tau) / running : 1;
  }
  const cands: Cand[] = [];
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (d[tau] < 0.35 && d[tau] <= d[tau - 1] && d[tau] < d[tau + 1]) cands.push({ tau, val: d[tau] });
  }
  return cands;
}

function refine(d: Float32Array, tau: number, tauMax: number): number {
  if (tau <= 1 || tau >= tauMax) return tau;
  const s0 = d[tau - 1];
  const s1 = d[tau];
  const s2 = d[tau + 1];
  const denom = 2 * (2 * s1 - s2 - s0);
  return denom !== 0 ? tau + (s2 - s0) / denom : tau;
}

export interface MelodyResult {
  hz: Float32Array;
  rmsDb: Float32Array;
  clarity: Float32Array;
  hop: number;
  t0: number;
}

/** Extract the vocal melody from a mono mix (fallback mode). `mono` is modified in place. */
export function extractMelody(mono: Float32Array, sampleRate: number, onProgress?: (p: number) => void): MelodyResult {

  highpass(mono, sampleRate, 150);
  const W = 2048;
  const hop = 256;
  const fmin = 100;
  const fmax = 1000;
  const n = Math.max(0, Math.floor((mono.length - W) / hop));
  const hz = new Float32Array(n);
  const rmsDb = new Float32Array(n);
  const clarity = new Float32Array(n);
  const d = new Float32Array(W / 2 + 2);
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (W - 1));
  const tauMax = Math.min(W >> 1, Math.ceil(sampleRate / fmin));
  let lastProgress = 0;
  let prevHz = 0;
  for (let i = 0; i < n; i++) {
    const off = i * hop;
    let s = 0;
    for (let k = 0; k < W; k++) s += mono[off + k] * mono[off + k];
    const rms = Math.sqrt(s / W);
    rmsDb[i] = rms > 0 ? 20 * Math.log10(rms) : -100;
    if (rms < 0.003) {
      hz[i] = 0;
      prevHz = 0;
      continue;
    }
    const cands = yinCandidates(mono, off, W, sampleRate, fmin, fmax, d);
    if (cands.length === 0) {
      hz[i] = 0;
      prevHz = 0;
      continue;
    }
    // choose the candidate with the strongest harmonic series, favouring low YIN error and continuity
    let best: Cand | null = null;
    let bestScore = -Infinity;
    // Each YIN candidate may be a sub-harmonic of the voice (a bass note or chord tone whose
    // period divides the voice's): also consider its multiples and let harmonic salience decide.
    const top: { c: Cand; f: number; sal: number }[] = [];
    for (const c of cands.slice(0, 6)) {
      const base = sampleRate / c.tau;
      for (const mult of [1, 2, 3, 4]) {
        const f = base * mult;
        if (f > fmax) break;
        top.push({ c, f, sal: harmonicEnergy(mono, off, W, win, f, sampleRate, [1, 2, 3, 4, 5, 6]) });
      }
    }
    const salMax = Math.max(1e-12, ...top.map((t) => t.sal));
    let bestF = 0;
    for (const t of top) {
      let score = t.sal / salMax + 0.3 * (1 - t.c.val);
      if (prevHz > 0) {
        const jump = Math.abs(Math.log2(t.f / prevHz));
        if (jump < 0.1) score += 0.15;
        else if (Math.abs(jump - 1) < 0.08) score -= 0.15; // discourage octave flips
      }
      if (score > bestScore) {
        bestScore = score;
        best = t.c;
        bestF = t.f;
      }
    }
    if (!best) {
      hz[i] = 0;
      continue;
    }
    const baseF = sampleRate / best.tau;
    let f0 = (sampleRate / refine(d, best.tau, tauMax)) * Math.round(bestF / baseF);
    // harmonic parity: when the even harmonics carry clearly more energy than the odd ones,
    // the candidate is a sub-octave (a bass or chord tone under the voice): go one octave up.
    for (let k = 0; k < 2 && f0 * 2 <= fmax; k++) {
      const odd = seriesEnergy(mono, off, W, win, f0, sampleRate, [1, 3, 5]);
      const even = seriesEnergy(mono, off, W, win, f0, sampleRate, [2, 4, 6]);
      if (even > odd * 1.5) f0 *= 2;
      else break;
    }
    clarity[i] = 1 - best.val;
    hz[i] = f0;
    prevHz = f0;
    const p = i / n;
    if (p - lastProgress > 0.02) {
      lastProgress = p;
      onProgress?.(p);
    }
  }
  return { hz, rmsDb, clarity, hop: hop / sampleRate, t0: W / 2 / sampleRate };
}
