// pYIN-style probabilistic pitch tracking, main-thread half.
//
// The worklet (public/pitch-worklet.js) computes the YIN cumulative-mean-normalised difference
// function once per hop and ships every local minimum ("dip") as a candidate period. This module
//   1. turns the dips of one frame into pitch candidates with probabilities, by integrating a
//      Beta distribution of YIN thresholds (a dip is "the" period for every threshold that it is
//      the first dip to fall under), and
//   2. smooths the candidate sequence with a fixed-lag Viterbi decoder over a voiced/unvoiced
//      state and a pitch-continuity prior, emitting each frame `lookahead` hops after it arrived
//      with its own timestamp, plus the posterior probability that it is voiced.
//
// It is pure TypeScript with no DOM or audio dependencies, so the self-test can drive it.

export interface Dip {
  hz: number;
  d: number; // interpolated minimum of the normalised difference function, 0 (periodic) .. 1
}

export interface Candidate extends Dip {
  p: number; // probability mass assigned to this period
}

export interface TrackerInput {
  tCtx: number;
  silent: boolean; // below the level gate: no analysis was run
  dips: Dip[]; // ascending period (descending hz), as the worklet scans them
}

export interface TrackedFrame<T extends TrackerInput> {
  input: T;
  hz: number; // 0 when unvoiced
  d: number; // aperiodicity of the chosen candidate (or of the deepest dip when unvoiced; 1 when silent)
  voiced: boolean; // decision of the smoothed path
  voicing: number; // posterior P(voiced | frames up to lookahead) in 0..1
  candidates: Candidate[];
}

export interface TrackerOptions {
  lookahead?: number; // frames of delay (default 3)
  maxCandidates?: number; // per frame (default 5)
  switchCost?: number; // nats to change voiced ↔ unvoiced (default 2.5)
  semitoneCost?: number; // nats per semitone of pitch change between hops, capped (default 1.0)
  jumpCap?: number; // semitones after which the pitch-change cost stops growing (default 5)
  octaveExtra?: number; // extra nats when the jump is within ±0.6 st of an octave multiple (default 1.5)
  unvoicedStayCost?: number; // nats per hop for staying unvoiced; rewards a steady pitch over noise (default 0.3)
  betaA?: number; // YIN threshold prior Beta(a, b) for the choice of period; default (2, 8), mean 0.2
  betaB?: number;
}

const LOG_FLOOR = 1e-4;

/** Cumulative distribution of Beta(a, b) tabulated on [0, 1] (n + 1 points), by trapezoid integration. */
export function betaCdfTable(a: number, b: number, n = 512): Float64Array {
  const pdf = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    pdf[i] = Math.pow(x, a - 1) * Math.pow(1 - x, b - 1);
  }
  const cdf = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) cdf[i] = cdf[i - 1] + 0.5 * (pdf[i - 1] + pdf[i]);
  const total = cdf[n];
  for (let i = 0; i <= n; i++) cdf[i] /= total;
  return cdf;
}

export function cdfAt(table: Float64Array, x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const pos = x * (table.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return table[i] + (table[Math.min(table.length - 1, i + 1)] - table[i]) * f;
}

/**
 * Probability that a frame with deepest dip `dmin` is voiced, before smoothing: a logistic in the
 * aperiodicity. d′ = 0.05 → 0.98, 0.15 → 0.92, 0.25 → 0.78, 0.35 → 0.5, 0.45 → 0.22, 0.55 → 0.08.
 * (Clear singing sits at 0.02–0.15, breathy or quiet singing at 0.2–0.4, noise above 0.5.)
 */
export function voicedProbability(dmin: number, mid = 0.35, width = 0.08): number {
  if (!(dmin < 1)) return 0;
  return 1 / (1 + Math.exp((dmin - mid) / width));
}

/**
 * Candidate probabilities from the dips of one frame (pYIN step 1). The dips must be in ascending
 * period order. Which period: for a threshold s, YIN picks the first dip with d < s; integrating
 * over the (strict, Beta) threshold prior gives each dip the mass between its own depth and the
 * depth of the shallowest dip before it; the leftover "no dip under threshold" mass goes to the
 * first dip within `nearMin` of the minimum (YIN's global-minimum fallback, robust to noise), and
 * every dip keeps a floor of `floor`·(1 − d). Whether voiced: `voicedProbability(dmin)`.
 * Returns the `maxCandidates` most probable candidates (p summing to ≤ P(voiced)) and P(unvoiced).
 */
export function scoreCandidates(
  dips: Dip[],
  cdf: Float64Array,
  maxCandidates = 5,
  nearMin = 0.025,
  floor = 0.05,
): { candidates: Candidate[]; unvoiced: number; dmin: number } {
  if (dips.length === 0) return { candidates: [], unvoiced: 1, dmin: 1 };
  let prevMin = 1;
  let dmin = 1;
  let deepest = -1;
  const scored: Candidate[] = [];
  for (let i = 0; i < dips.length; i++) {
    const dip = dips[i];
    const d = Math.max(0, Math.min(1, dip.d));
    let p = 0;
    if (d < prevMin) {
      p = cdfAt(cdf, prevMin) - cdfAt(cdf, d);
      prevMin = d;
    }
    if (d < dmin) {
      dmin = d;
      deepest = scored.length;
    }
    scored.push({ hz: dip.hz, d, p });
  }
  // "no dip under the threshold": YIN falls back to the global minimum. Under noise the dips at
  // T and 2T are equally deep (d(2T) ≈ d(T)), so take the first dip within `nearMin` of the
  // minimum, which is the shorter period, instead of whichever noise made marginally deeper.
  if (deepest >= 0) {
    let target = deepest;
    for (let i = 0; i < scored.length; i++) {
      if (scored[i].d <= dmin + nearMin) {
        target = i;
        break;
      }
    }
    scored[target].p += cdfAt(cdf, dmin);
  }
  // a small floor so a steady pitch stays reachable for the smoother even on a frame where a
  // deeper (octave) dip precedes it; the smoother's transition prior does the rest
  for (const c of scored) c.p += floor * (1 - c.d);
  const voiced = voicedProbability(dmin);
  let total = 0;
  for (const c of scored) total += c.p;
  for (const c of scored) c.p = total > 0 ? (c.p / total) * voiced : 0;
  scored.sort((a, b) => b.p - a.p);
  const candidates = scored.slice(0, maxCandidates).filter((c) => c.p > 1e-5);
  return { candidates, unvoiced: 1 - voiced, dmin };
}

interface Frame<T extends TrackerInput> {
  input: T;
  candidates: Candidate[];
  unvoiced: number;
  dmin: number;
  emis: Float64Array; // −log emission probability per state; state 0 = unvoiced, i ≥ 1 = candidates[i−1]
  midi: Float64Array; // per state (NaN for unvoiced)
}

interface Decided {
  voiced: boolean;
  midi: number;
}

function logSumExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = a > b ? a : b;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/**
 * Fixed-lag Viterbi over voiced/unvoiced candidates. `push` returns the frame decided by this
 * push (none until `lookahead` frames are buffered); `flush` decides whatever remains.
 */
export class PitchTracker<T extends TrackerInput = TrackerInput> {
  private readonly lookahead: number;
  private readonly maxCandidates: number;
  private readonly switchCost: number;
  private readonly semitoneCost: number;
  private readonly jumpCap: number;
  private readonly octaveExtra: number;
  private readonly unvoicedStayCost: number;
  private readonly cdf: Float64Array;
  private buffer: Frame<T>[] = [];
  private last: Decided = { voiced: false, midi: NaN };

  constructor(opts: TrackerOptions = {}) {
    this.lookahead = Math.max(0, opts.lookahead ?? 3);
    this.maxCandidates = opts.maxCandidates ?? 5;
    this.switchCost = opts.switchCost ?? 2.5;
    this.semitoneCost = opts.semitoneCost ?? 1.0;
    this.jumpCap = opts.jumpCap ?? 5;
    this.octaveExtra = opts.octaveExtra ?? 1.5;
    this.unvoicedStayCost = opts.unvoicedStayCost ?? 0.3;
    this.cdf = betaCdfTable(opts.betaA ?? 2, opts.betaB ?? 8);
  }

  /** Added delay in frames. */
  get delayFrames(): number {
    return this.lookahead;
  }

  reset(): void {
    this.buffer = [];
    this.last = { voiced: false, midi: NaN };
  }

  push(input: T): TrackedFrame<T> | null {
    this.buffer.push(this.makeFrame(input));
    if (this.buffer.length <= this.lookahead) return null;
    return this.decideFirst();
  }

  flush(): TrackedFrame<T>[] {
    const out: TrackedFrame<T>[] = [];
    while (this.buffer.length) out.push(this.decideFirst());
    return out;
  }

  private makeFrame(input: T): Frame<T> {
    const { candidates, unvoiced, dmin } = input.silent
      ? { candidates: [] as Candidate[], unvoiced: 1, dmin: 1 }
      : scoreCandidates(input.dips, this.cdf, this.maxCandidates);
    const n = candidates.length + 1;
    const emis = new Float64Array(n);
    const midi = new Float64Array(n);
    emis[0] = -Math.log(Math.max(LOG_FLOOR, unvoiced));
    midi[0] = NaN;
    for (let i = 0; i < candidates.length; i++) {
      emis[i + 1] = -Math.log(Math.max(LOG_FLOOR, candidates[i].p));
      midi[i + 1] = 69 + 12 * Math.log2(candidates[i].hz / 440);
    }
    return { input, candidates, unvoiced, dmin, emis, midi };
  }

  /** Transition cost (nats) from a previous state to a new one. */
  private transition(prevVoiced: boolean, prevMidi: number, voiced: boolean, midi: number): number {
    if (!prevVoiced && !voiced) return this.unvoicedStayCost;
    if (prevVoiced !== voiced) return this.switchCost;
    if (prevMidi !== prevMidi) return 0; // voiced with unknown previous pitch (start)
    const jump = Math.abs(midi - prevMidi);
    let cost = Math.min(jump, this.jumpCap) * this.semitoneCost;
    const octaves = Math.round(jump / 12);
    if (octaves >= 1 && Math.abs(jump - octaves * 12) < 0.6) cost += this.octaveExtra;
    return cost;
  }

  private decideFirst(): TrackedFrame<T> {
    const frames = this.buffer;
    const M = frames.length;
    // ---- Viterbi forward pass from the last decided state ----
    const costs: Float64Array[] = [];
    const back: Int16Array[] = [];
    // forward-backward in the log domain for the voicing posterior of frame 0
    const alpha: Float64Array[] = [];
    for (let k = 0; k < M; k++) {
      const f = frames[k];
      const n = f.emis.length;
      const c = new Float64Array(n);
      const b = new Int16Array(n);
      const a = new Float64Array(n);
      for (let s = 0; s < n; s++) {
        const voiced = s > 0;
        let best = Infinity;
        let bestFrom = -1;
        let lse = -Infinity;
        if (k === 0) {
          const tr = this.transition(this.last.voiced, this.last.midi, voiced, f.midi[s]);
          best = tr + f.emis[s];
          lse = -tr - f.emis[s];
        } else {
          const prev = frames[k - 1];
          const pc = costs[k - 1];
          const pa = alpha[k - 1];
          for (let q = 0; q < prev.emis.length; q++) {
            const tr = this.transition(q > 0, prev.midi[q], voiced, f.midi[s]);
            const total = pc[q] + tr;
            if (total < best) {
              best = total;
              bestFrom = q;
            }
            lse = logSumExp(lse, pa[q] - tr);
          }
          best += f.emis[s];
          lse -= f.emis[s];
        }
        c[s] = best;
        b[s] = bestFrom;
        a[s] = lse;
      }
      costs.push(c);
      back.push(b);
      alpha.push(a);
    }
    // ---- backtrack from the best final state to frame 0 ----
    const lastCosts = costs[M - 1];
    let state = 0;
    for (let s = 1; s < lastCosts.length; s++) if (lastCosts[s] < lastCosts[state]) state = s;
    for (let k = M - 1; k > 0; k--) state = back[k][state];
    // ---- backward pass for the posterior of frame 0 ----
    let beta: Float64Array = new Float64Array(frames[M - 1].emis.length); // log 1 = 0
    for (let k = M - 1; k > 0; k--) {
      const f = frames[k];
      const prev = frames[k - 1];
      const nb = new Float64Array(prev.emis.length);
      for (let q = 0; q < prev.emis.length; q++) {
        let lse = -Infinity;
        for (let s = 0; s < f.emis.length; s++) {
          const tr = this.transition(q > 0, prev.midi[q], s > 0, f.midi[s]);
          lse = logSumExp(lse, -tr - f.emis[s] + beta[s]);
        }
        nb[q] = lse;
      }
      beta = nb;
    }
    const a0 = alpha[0];
    let logVoiced = -Infinity;
    let logAll = -Infinity;
    for (let s = 0; s < a0.length; s++) {
      const v = a0[s] + beta[s];
      logAll = logSumExp(logAll, v);
      if (s > 0) logVoiced = logSumExp(logVoiced, v);
    }
    let voicing = logAll === -Infinity ? 0 : Math.exp(logVoiced - logAll);
    if (!(voicing >= 0)) voicing = 0;
    if (voicing > 1) voicing = 1;

    const f0 = frames.shift()!;
    let voiced = state > 0;
    // guard against a MAP/posterior disagreement on a frame whose evidence is weak
    if (voiced && voicing < 0.2) {
      voiced = false;
      state = 0;
    }
    const cand = voiced ? f0.candidates[state - 1] : null;
    this.last = { voiced, midi: voiced ? f0.midi[state] : NaN };
    return {
      input: f0.input,
      hz: cand ? cand.hz : 0,
      d: cand ? cand.d : f0.dmin,
      voiced,
      voicing,
      candidates: f0.candidates,
    };
  }
}
