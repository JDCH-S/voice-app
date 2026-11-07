// Technique detection: breathy tone, strain, cracks and running out of air, from the singer's
// pitch frames and the reference notes. Pure functions, no DOM.
//
// The voice-quality fields on PitchFrame (voicing, hnr, breathiness, pressed, peak) are optional:
// older recordings and simpler analysers do not have them. Every rule degrades gracefully: when a
// field is missing the rule that needs it is skipped, and only the pitch/level based rules
// ('crack', 'out-of-air') remain.

import type { IssueKind, NoteIssue, NoteResult, PitchFrame, RefNote } from '../types';
import { clamp, median, midiToName } from '../music/notes';

export type TechniqueKind = Extract<IssueKind, 'breathy' | 'strain' | 'crack' | 'out-of-air'>;

export const TECHNIQUE_KINDS: TechniqueKind[] = ['breathy', 'strain', 'crack', 'out-of-air'];

export interface TechniqueOptions {
  /** Transposition applied to the reference (semitones). */
  semitones: number;
  /** Accept singing in another octave (errors are folded to the nearest octave). */
  allowOctave: boolean;
  /** Top of the singer's comfortable range (MIDI); enables the "clipping on high notes" strain rule. */
  highMidi?: number;
  /** Per-note results from scorePhrase, when available (used to skip missed notes). */
  noteResults?: NoteResult[];
}

/** Which optional voice-quality fields were present in the frames (so the UI can say what was checked). */
export interface TechniqueFields {
  voicing: boolean;
  hnr: boolean;
  breathiness: boolean;
  pressed: boolean;
  peak: boolean;
}

export interface TechniqueSummary {
  /** Number of notes flagged per kind. */
  counts: Record<TechniqueKind, number>;
  /** Worst severity per kind (0 when none). */
  severity: Record<TechniqueKind, number>;
  /** 0..100: 100 = nothing wrong with the technique that we could hear. */
  score: number;
  /** Notes long enough to be checked (so counts can be read as a ratio). */
  notesChecked: number;
  fields: TechniqueFields;
}

export interface TechniqueResult {
  issues: NoteIssue[];
  summary: TechniqueSummary;
  /** Expression-bucket contributions for scorePhrase (weight, score 0..100). */
  exprScores: { w: number; s: number }[];
}

// ---- thresholds (from docs/ROADMAP-PRO.md, package B) ----
export const TECH = {
  breathyMinDur: 0.3,
  breathyIndex: 0.6,
  breathyHnrDb: 8,
  pressedIndex: 0.7,
  pressedSustain: 0.25,
  clipPeak: 0.97,
  clipFraction: 0.1,
  crackMinDur: 0.4,
  crackJumpSemis: 5,
  crackHold: 0.04,
  crackContext: 0.08,
  outOfAirMinDur: 1.0,
  outOfAirDropDb: 8,
  outOfAirSagCents: 25,
} as const;

const voiced = (f: PitchFrame) => f.hz > 0 && f.clarity > 0.5;

function label(n: RefNote, semis: number): string {
  const name = midiToName(n.midi + semis);
  return n.lyric ? `"${n.lyric}" (${name})` : name;
}

function fieldsOf(frames: PitchFrame[]): TechniqueFields {
  const has = (k: keyof PitchFrame) => frames.some((f) => typeof f[k] === 'number' && !isNaN(f[k] as number));
  return { voicing: has('voicing'), hnr: has('hnr'), breathiness: has('breathiness'), pressed: has('pressed'), peak: has('peak') };
}

function num(v: number | undefined): v is number {
  return typeof v === 'number' && !isNaN(v);
}

function frameDtOf(frames: PitchFrame[]): number {
  const dts: number[] = [];
  for (let i = 1; i < Math.min(frames.length, 200); i++) dts.push(frames[i].t - frames[i - 1].t);
  return dts.length ? clamp(median(dts), 0.005, 0.05) : 0.0107;
}

function emptySummary(fields: TechniqueFields): TechniqueSummary {
  return {
    counts: { breathy: 0, strain: 0, crack: 0, 'out-of-air': 0 },
    severity: { breathy: 0, strain: 0, crack: 0, 'out-of-air': 0 },
    score: 100,
    notesChecked: 0,
    fields,
  };
}

/**
 * Longest stretch of time (seconds) over consecutive frames for which `pred` holds.
 * Measured from the first to the last frame of the run plus one frame step.
 */
function longestRun(fs: PitchFrame[], pred: (f: PitchFrame) => boolean, dt: number): number {
  let best = 0;
  let start: number | null = null;
  let last = 0;
  for (const f of fs) {
    if (pred(f)) {
      if (start === null) start = f.t;
      last = f.t;
      best = Math.max(best, last - start + dt);
    } else start = null;
  }
  return best;
}

// ---------- individual rules (exported for tests) ----------

/** Breathy: median breathiness ≥ 0.6 (or, without a breathiness index, median HNR < 8 dB) on notes ≥ 0.3 s. */
export function breathyOn(n: RefNote, core: PitchFrame[]): { amount: number; severity: number } | null {
  if (n.end - n.start < TECH.breathyMinDur || core.length < 5) return null;
  const br = core.map((f) => f.breathiness).filter(num);
  if (br.length >= Math.max(3, core.length * 0.5)) {
    const m = median(br);
    if (m >= TECH.breathyIndex) return { amount: m, severity: clamp(0.3 + (m - TECH.breathyIndex) * 1.5, 0.3, 0.9) };
    return null;
  }
  const hnr = core.map((f) => f.hnr).filter(num);
  if (hnr.length >= Math.max(3, core.length * 0.5)) {
    const m = median(hnr);
    if (m < TECH.breathyHnrDb) return { amount: m, severity: clamp(0.3 + (TECH.breathyHnrDb - m) * 0.08, 0.3, 0.9) };
  }
  return null;
}

/** Strain: pressed ≥ 0.7 sustained ≥ 0.25 s, or clipping peaks (≥ 10 % of frames) on a high note. */
export function strainOn(
  n: RefNote,
  span: PitchFrame[],
  dt: number,
  semis: number,
  highMidi: number | undefined,
  phraseRange: { top: number; low: number },
): { amount: number; severity: number; why: 'pressed' | 'clipping' } | null {
  const pressedFrames = span.filter((f) => num(f.pressed));
  if (pressedFrames.length >= 3) {
    const run = longestRun(span, (f) => num(f.pressed) && (f.pressed as number) >= TECH.pressedIndex, dt);
    if (run >= TECH.pressedSustain) {
      const peakP = Math.max(...pressedFrames.map((f) => f.pressed as number));
      return { amount: run, severity: clamp(0.45 + (peakP - TECH.pressedIndex) + (run - TECH.pressedSustain) * 0.5, 0.45, 1), why: 'pressed' };
    }
  }
  const target = n.midi + semis;
  // "high": near the top of the singer's range when known, else the top of a phrase that spans ≥ 4 semitones
  const isHigh = highMidi !== undefined ? target >= highMidi - 2 : phraseRange.top - phraseRange.low >= 4 && target >= phraseRange.top - 1;
  if (isHigh) {
    const withPeak = span.filter((f) => num(f.peak));
    if (withPeak.length >= 3) {
      const clipped = withPeak.filter((f) => (f.peak as number) >= TECH.clipPeak).length;
      const frac = clipped / withPeak.length;
      if (clipped >= 3 && frac >= TECH.clipFraction) return { amount: frac, severity: clamp(0.4 + frac, 0.4, 0.9), why: 'clipping' };
    }
  }
  return null;
}

/**
 * Crack: inside a note ≥ 0.4 s, a pitch jump ≥ 5 semitones that holds ≥ 40 ms, with a voicing
 * dropout or a clarity collapse within ±80 ms of the jump. Steady octave-down singing is not a
 * crack (the pitch never jumps), and the first 60 ms of a note (onset, reference slides) are skipped.
 */
export function crackOn(n: RefNote, span: PitchFrame[], dt: number): { amount: number; severity: number; at: number } | null {
  if (n.end - n.start < TECH.crackMinDur) return null;
  const from = n.start + Math.max(0.06, n.slideIn ? n.slideIn.duration + 0.03 : 0);
  const inside = span.filter((f) => f.t >= from && f.t <= n.end);
  const v = inside.filter(voiced);
  if (v.length < 6) return null;
  const clarMed = median(v.map((f) => f.clarity));
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1];
    const b = v[i];
    if (b.t - a.t > 0.25) continue; // not a jump, a different note region
    const jump = b.midi - a.midi;
    if (Math.abs(jump) < TECH.crackJumpSemis) continue;
    // the new pitch must hold ≥ 40 ms (frames within 1.5 semitones of it)
    let hold = dt;
    let j = i + 1;
    while (j < v.length && Math.abs(v[j].midi - b.midi) < 1.5 && v[j].t - v[j - 1].t <= 0.1) {
      hold = v[j].t - b.t + dt;
      j++;
    }
    if (hold < TECH.crackHold) continue;
    // the old pitch must also have been established (not a single stray frame)
    let before = dt;
    let k = i - 2;
    while (k >= 0 && Math.abs(v[k].midi - a.midi) < 1.5) {
      before = a.t - v[k].t + dt;
      k--;
    }
    if (before < TECH.crackHold) continue;
    // around the jump: a voicing dropout or a clarity collapse
    const ctx = span.filter((f) => f.t >= a.t - TECH.crackContext && f.t <= b.t + TECH.crackContext);
    const dropout = ctx.some((f) => f.hz <= 0 || (num(f.voicing) && (f.voicing as number) < 0.5)) || b.t - a.t > dt * 2.5;
    const collapse = ctx.some((f) => f.hz > 0 && f.clarity < Math.min(0.6, clarMed * 0.75));
    if (!dropout && !collapse) continue;
    return { amount: Math.abs(jump), severity: clamp(0.4 + Math.abs(jump) * 0.03 + hold * 0.4, 0.4, 0.9), at: b.t };
  }
  return null;
}

/** Out of air: on notes ≥ 1 s, level drops ≥ 8 dB over the last 40 % while the pitch sags ≥ 25 cents. */
export function outOfAirOn(n: RefNote, span: PitchFrame[]): { dropDb: number; sagCents: number; severity: number } | null {
  const dur = n.end - n.start;
  if (dur < TECH.outOfAirMinDur) return null;
  const v = span.filter(voiced).filter((f) => f.t >= n.start && f.t <= n.end);
  if (v.length < 12) return null;
  const early = v.filter((f) => f.t >= n.start + dur * 0.15 && f.t < n.start + dur * 0.6);
  const late = v.filter((f) => f.t >= n.start + dur * 0.8);
  if (early.length < 4 || late.length < 4) return null;
  const dropDb = median(early.map((f) => f.db)) - median(late.map((f) => f.db));
  const sagCents = (median(early.map((f) => f.midi)) - median(late.map((f) => f.midi))) * 100;
  if (dropDb >= TECH.outOfAirDropDb && sagCents >= TECH.outOfAirSagCents) {
    return { dropDb, sagCents, severity: clamp(0.35 + (dropDb - TECH.outOfAirDropDb) * 0.03 + (sagCents - TECH.outOfAirSagCents) * 0.004, 0.35, 0.9) };
  }
  return null;
}

// ---------- main entry ----------

/**
 * Detect technique issues on the given reference notes from the singer's frames.
 * `frames` should be song-time pitch frames covering the notes (sorted or not).
 */
export function detectTechnique(notes: RefNote[], framesIn: PitchFrame[], opts: TechniqueOptions): TechniqueResult {
  const frames = [...framesIn].sort((a, b) => a.t - b.t);
  const fields = fieldsOf(frames);
  const summary = emptySummary(fields);
  const issues: NoteIssue[] = [];
  const exprScores: { w: number; s: number }[] = [];
  if (notes.length === 0 || frames.length === 0) return { issues, summary, exprScores };
  const dt = frameDtOf(frames);
  const semis = opts.semitones;
  const phraseRange = { top: Math.max(...notes.map((n) => n.midi + semis)), low: Math.min(...notes.map((n) => n.midi + semis)) };
  const statusOf = new Map<number, NoteResult['status']>();
  for (const r of opts.noteResults ?? []) statusOf.set(r.noteId, r.status);

  const add = (kind: TechniqueKind, n: RefNote, amount: number, severity: number, text: string) => {
    issues.push({ noteId: n.id, kind, amount, text, severity });
    summary.counts[kind]++;
    summary.severity[kind] = Math.max(summary.severity[kind], severity);
    exprScores.push({ w: 0.6, s: Math.max(0, 100 - severity * 100) });
  };

  for (const n of notes) {
    const dur = n.end - n.start;
    if (dur < TECH.breathyMinDur) continue;
    if (statusOf.get(n.id) === 'missed') continue;
    const span = frames.filter((f) => f.t >= n.start - 0.05 && f.t <= n.end + 0.05);
    if (span.length === 0) continue;
    const coreA = n.start + Math.min(0.06, dur * 0.25);
    const coreB = n.end - Math.min(0.04, dur * 0.2);
    const core = span.filter((f) => f.t >= coreA && f.t <= coreB && voiced(f));
    // when no note results are given, skip notes that were clearly not sung
    if (!statusOf.has(n.id) && core.length < 4) continue;
    summary.notesChecked++;

    const br = breathyOn(n, core);
    if (br) add('breathy', n, br.amount, br.severity, `${label(n, semis)} sounded breathy: too much air, not enough tone`);

    const st = strainOn(n, span, dt, semis, opts.highMidi, phraseRange);
    if (st)
      add(
        'strain',
        n,
        st.amount,
        st.severity,
        st.why === 'pressed' ? `${label(n, semis)} sounded pushed; ease off and let it be lighter` : `${label(n, semis)} was shouted so hard the microphone clipped`,
      );

    const cr = crackOn(n, span, dt);
    if (cr) add('crack', n, cr.amount, cr.severity, `Your voice cracked on ${label(n, semis)} (a ${Math.round(cr.amount)}-semitone flip)`);

    const oa = outOfAirOn(n, span);
    if (oa) add('out-of-air', n, oa.dropDb, oa.severity, `You ran out of air on ${label(n, semis)}: it faded ${Math.round(oa.dropDb)} dB and sagged ${Math.round(oa.sagCents)} cents`);
  }

  const penalty = TECHNIQUE_KINDS.reduce((a, k) => a + summary.severity[k] * 25 + Math.max(0, summary.counts[k] - 1) * 5, 0);
  summary.score = Math.round(clamp(100 - penalty, 0, 100));
  return { issues, summary, exprScores };
}

/** One plain sentence about the technique summary, or null when nothing was flagged. */
export function describeTechnique(s: TechniqueSummary): string | null {
  const parts: string[] = [];
  if (s.counts.strain) parts.push(`${s.counts.strain} pushed`);
  if (s.counts.crack) parts.push(`${s.counts.crack} cracked`);
  if (s.counts.breathy) parts.push(`${s.counts.breathy} breathy`);
  if (s.counts['out-of-air']) parts.push(`${s.counts['out-of-air']} out of air`);
  if (parts.length === 0) return null;
  const notes = s.notesChecked === 1 ? 'note' : 'notes';
  return `Technique: ${parts.join(', ')} of ${s.notesChecked} ${notes} checked.`;
}
