import type { CriterionScore, IssueKind, Level, NoteIssue, NoteResult, Phrase, PitchFrame, RefNote, SongAnalysis, Tip } from '../types';
import { median, mean, std, midiToName, clamp } from '../music/notes';
import { detectVibrato } from '../analysis/segment';

export interface ScoreOptions {
  semitones: number;
  level: Level;
  allowOctave: boolean;
}

export interface PhraseScore {
  scores: CriterionScore;
  issues: NoteIssue[];
  noteResults: NoteResult[];
  tip: Tip;
}

export function tolerances(level: Level) {
  switch (level) {
    case 'advanced':
      return { cents: 20, onset: 0.08 };
    case 'intermediate':
      return { cents: 35, onset: 0.12 };
    default:
      return { cents: 50, onset: 0.15 };
  }
}

function label(n: RefNote, semis: number): string {
  const name = midiToName(n.midi + semis);
  return n.lyric ? `"${n.lyric}" (${name})` : name;
}

function foldOctave(err: number, allow: boolean): { err: number; oct: number } {
  if (!allow) return { err, oct: 0 };
  const oct = Math.round(err / 12);
  return { err: err - 12 * oct, oct };
}

/** Score the user's pitch frames against one phrase of the reference. */
export function scorePhrase(analysis: SongAnalysis, phrase: Phrase, framesIn: PitchFrame[], opts: ScoreOptions): PhraseScore {
  const tol = tolerances(opts.level);
  const semis = opts.semitones;
  const frames = framesIn.filter((f) => f.t >= phrase.start - 0.4 && f.t <= phrase.end + 0.6).sort((a, b) => a.t - b.t);
  const dts: number[] = [];
  for (let i = 1; i < Math.min(frames.length, 200); i++) dts.push(frames[i].t - frames[i - 1].t);
  const frameDt = dts.length ? clamp(median(dts), 0.005, 0.05) : 0.0107;
  const notes = phrase.noteIds.map((id) => analysis.notes[id]);
  const issues: NoteIssue[] = [];
  const results: NoteResult[] = [];

  const pitchScores: { w: number; s: number }[] = [];
  const timingScores: { w: number; s: number }[] = [];
  const lengthScores: { w: number; s: number }[] = [];
  const exprScores: { w: number; s: number }[] = [];
  const userDbPerNote: (number | null)[] = [];

  const voiced = (f: PitchFrame) => f.hz > 0 && f.clarity > 0.5;

  for (let ni = 0; ni < notes.length; ni++) {
    const n = notes[ni];
    const prev = ni > 0 ? notes[ni - 1] : null;
    const next = ni + 1 < notes.length ? notes[ni + 1] : null;
    const target = n.midi + semis + n.cents / 100;
    const dur = n.end - n.start;
    const w = Math.max(0.15, Math.min(2.5, dur)); // weight by duration, bounded
    const coreA = n.start + Math.min(0.06, dur * 0.25);
    const coreB = n.end - Math.min(0.04, dur * 0.2);
    const core = frames.filter((f) => f.t >= coreA && f.t <= coreB);
    const coreVoiced = core.filter(voiced);
    const expected = Math.max(1, (coreB - coreA) / frameDt);
    const coverage = clamp(coreVoiced.length / expected, 0, 1);

    // matching frames: within 2.5 semitones of target (octave folded)
    const errsRaw = coreVoiced.map((f) => f.midi - target);
    const folded = errsRaw.map((e) => foldOctave(e, opts.allowOctave));
    const octVotes = folded.map((f) => f.oct);
    const oct = octVotes.length ? Math.round(median(octVotes)) : 0;
    const matching = coreVoiced.filter((f, i) => Math.abs(folded[i].err) < 2.5 && folded[i].oct === oct);
    const matchErrs = matching.map((f) => (f.midi - target - 12 * oct) * 100);
    const missedThreshold = dur < 0.12 ? 0.15 : 0.3;
    const missed = coverage < missedThreshold || matching.length < Math.max(1, expected * 0.2);

    const res: NoteResult = {
      noteId: n.id,
      sungMidi: null,
      centsError: null,
      onsetDelta: null,
      heldRatio: null,
      coverage,
      status: 'missed',
    };
    userDbPerNote.push(matching.length ? mean(matching.map((f) => f.db)) : null);

    if (missed) {
      results.push(res);
      pitchScores.push({ w, s: 0 });
      timingScores.push({ w, s: 0 });
      if (dur >= 0.3) lengthScores.push({ w, s: 0 });
      issues.push({
        noteId: n.id,
        kind: 'missed',
        amount: coverage,
        text: coverage < 0.15 ? `${label(n, semis)} was not sung` : `${label(n, semis)} was sung on the wrong note`,
        severity: clamp(0.5 + dur * 0.3, 0.5, 1),
      });
      continue;
    }

    const centsErr = median(matchErrs);
    const sungMidi = median(matching.map((f) => f.midi));
    res.sungMidi = sungMidi;
    res.centsError = centsErr;

    // ---- pitch ----
    const absErr = Math.abs(centsErr);
    let pitchS = absErr <= tol.cents / 2 ? 100 : absErr <= tol.cents ? 100 - ((absErr - tol.cents / 2) / (tol.cents / 2)) * 20 : Math.max(0, 80 - ((absErr - tol.cents) / (150 - tol.cents)) * 80);
    if (oct !== 0) {
      res.status = 'octave';
      issues.push({
        noteId: n.id,
        kind: 'octave',
        amount: oct,
        text: `${label(n, semis)} was sung an octave ${oct < 0 ? 'lower' : 'higher'}`,
        severity: 0.25,
      });
      pitchS *= 0.9;
    } else if (absErr > tol.cents) {
      res.status = centsErr > 0 ? 'sharp' : 'flat';
      issues.push({
        noteId: n.id,
        kind: centsErr > 0 ? 'sharp' : 'flat',
        amount: centsErr,
        text: `${label(n, semis)} was ${Math.round(absErr)} cents ${centsErr > 0 ? 'sharp' : 'flat'}`,
        severity: clamp(absErr / 120, 0.3, 1) * clamp(dur / 0.4, 0.5, 1),
      });
    } else res.status = 'good';

    // stability (on held notes where the reference is steady)
    if (dur >= 0.4 && matching.length >= 8) {
      const stab = std(matchErrs);
      const refHasVibrato = !!n.vibrato;
      if (stab > (refHasVibrato ? 60 : 40)) {
        pitchS *= 0.85;
        issues.push({
          noteId: n.id,
          kind: 'unstable',
          amount: stab,
          text: `${label(n, semis)} wobbled (±${Math.round(stab)} cents)`,
          severity: clamp(stab / 100, 0.3, 0.8),
        });
      }
    }
    pitchScores.push({ w, s: pitchS });

    // ---- timing ----
    const onsetWindow = frames.filter((f) => f.t >= n.start - 0.3 && f.t <= Math.min(n.end, n.start + 0.6));
    let onset: number | null = null;
    for (let i = 0; i < onsetWindow.length; i++) {
      const f = onsetWindow[i];
      if (!voiced(f)) continue;
      const e = foldOctave(f.midi - target, opts.allowOctave);
      if (Math.abs(e.err) < 1.0 && e.oct === oct) {
        // require the next voiced frame to match too
        const g = onsetWindow[i + 1];
        if (!g || (voiced(g) && Math.abs(foldOctave(g.midi - target, opts.allowOctave).err) < 1.2)) {
          onset = f.t;
          break;
        }
      }
    }
    // timing is only meaningful when the note starts something: first note, after a breath/gap, or after a pitch change
    const legatoFromPrev = prev && n.start - prev.end < 0.08 && Math.abs(prev.midi - n.midi) < 1;
    if (onset !== null && !legatoFromPrev) {
      const delta = onset - n.start;
      res.onsetDelta = delta;
      const ad = Math.abs(delta);
      const tS = ad <= tol.onset ? 100 : Math.max(0, 100 - ((ad - tol.onset) / 0.4) * 100);
      timingScores.push({ w, s: tS });
      if (ad > tol.onset) {
        issues.push({
          noteId: n.id,
          kind: delta > 0 ? 'late' : 'early',
          amount: delta,
          text: `${label(n, semis)} came in ${Math.round(ad * 1000)} ms ${delta > 0 ? 'late' : 'early'}`,
          severity: clamp(ad / 0.4, 0.3, 0.9),
        });
      }
    }

    // ---- length ----
    const tail = frames.filter((f) => f.t >= n.start && f.t <= n.end + Math.min(0.6, dur));
    let offset: number | null = null;
    for (let i = tail.length - 1; i >= 0; i--) {
      const f = tail[i];
      if (!voiced(f)) continue;
      const e = foldOctave(f.midi - target, opts.allowOctave);
      if (Math.abs(e.err) < 1.0 && e.oct === oct) {
        offset = f.t;
        break;
      }
    }
    if (dur >= 0.3 && offset !== null) {
      const start = onset ?? n.start;
      const held = (offset - start) / dur;
      res.heldRatio = held;
      let lS = 100;
      if (held < 0.8) lS = Math.max(0, (held / 0.8) * 100);
      else if (held > 1.5 && next && next.start - n.end > 0.15) lS = 70;
      lengthScores.push({ w, s: lS });
      if (held < 0.7) {
        issues.push({
          noteId: n.id,
          kind: 'short',
          amount: held,
          text: `${label(n, semis)} was held too short (${Math.round(held * 100)}% of ${dur.toFixed(1)} s)`,
          severity: clamp((0.8 - held) * 1.5, 0.3, 0.9) * clamp(dur / 0.8, 0.6, 1),
        });
      } else if (held > 1.5 && next && next.start - n.end > 0.15) {
        issues.push({ noteId: n.id, kind: 'long', amount: held, text: `${label(n, semis)} was held too long`, severity: 0.25 });
      }
    }

    // ---- expression: slide ----
    if (n.slideIn) {
      const span = Math.abs(n.midi - n.slideIn.fromMidi);
      const win = frames.filter((f) => f.t >= n.start - Math.max(0.2, n.slideIn!.duration + 0.08) && f.t <= n.start + 0.12 && voiced(f));
      let ok = false;
      if (win.length >= 3) {
        const mids = win.map((f) => f.midi - 12 * oct);
        const dir = Math.sign(n.midi - n.slideIn.fromMidi);
        let travelled = 0;
        for (let i = 1; i < mids.length; i++) {
          const d = (mids[i] - mids[i - 1]) * dir;
          if (d > 0 && d < 3) travelled += d;
        }
        ok = travelled >= span * 0.5;
      }
      exprScores.push({ w: 1, s: ok ? 100 : 0 });
      if (!ok)
        issues.push({
          noteId: n.id,
          kind: 'no-slide',
          amount: span,
          text: `Missed the slide into ${label(n, semis)} (from ${midiToName(n.slideIn.fromMidi + semis)})`,
          severity: 0.45,
        });
    }

    // ---- expression: vibrato ----
    if (n.vibrato && dur >= 0.5) {
      const cents = matching.map((f) => (f.midi - sungMidi) * 100);
      const v = detectVibrato(cents, frameDt);
      const sd = std(cents);
      const s = v ? 100 : sd > 10 ? 50 : 0;
      exprScores.push({ w: 1, s });
      if (!v)
        issues.push({
          noteId: n.id,
          kind: 'no-vibrato',
          amount: n.vibrato.extentCents,
          text: `${label(n, semis)} is sung with vibrato in the original; yours was straight`,
          severity: 0.3,
        });
    }
  }

  // ---- expression: dynamics (contour within the phrase) ----
  const refLoud = notes.map((n) => n.loudnessDb);
  const refMean = mean(refLoud);
  const userVals = userDbPerNote.filter((v): v is number => v !== null);
  if (userVals.length >= 2) {
    const userMean = mean(userVals);
    let worst: { idx: number; diff: number } | null = null;
    notes.forEach((n, i) => {
      const u = userDbPerNote[i];
      if (u === null) return;
      const refRel = n.loudnessDb - refMean;
      if (Math.abs(refRel) < 4) return;
      const diff = u - userMean - refRel;
      exprScores.push({ w: 0.7, s: Math.max(0, 100 - Math.abs(diff) * 10) });
      if (Math.abs(diff) > 5 && (!worst || Math.abs(diff) > Math.abs(worst.diff))) worst = { idx: i, diff };
    });
    if (worst) {
      const wn: { idx: number; diff: number } = worst;
      const n = notes[wn.idx];
      const soft = wn.diff < 0;
      issues.push({
        noteId: n.id,
        kind: soft ? 'too-soft' : 'too-loud',
        amount: wn.diff,
        text: soft
          ? `${label(n, semis)} should be louder than the notes around it (${n.dynamic})`
          : `${label(n, semis)} should be softer than the notes around it (${n.dynamic})`,
        severity: 0.3,
      });
    }
  }

  // ---- breath & broken lines ----
  for (let ni = 1; ni < notes.length; ni++) {
    const n = notes[ni];
    const prev = notes[ni - 1];
    const gap = n.start - prev.end;
    const between = frames.filter((f) => f.t >= prev.end - 0.05 && f.t <= n.start + 0.05);
    if (between.length < 3) continue;
    const unvoicedRun = longestUnvoiced(between, voiced);
    if (n.breathBefore || gap >= 0.25) {
      const ok = unvoicedRun >= 0.1;
      exprScores.push({ w: 0.5, s: ok ? 100 : 40 });
      if (!ok)
        issues.push({
          noteId: n.id,
          kind: 'no-breath',
          amount: gap,
          text: `Take a breath before ${label(n, semis)} like the original`,
          severity: 0.25,
        });
    } else if (gap < 0.1) {
      if (unvoicedRun >= 0.25) {
        exprScores.push({ w: 0.5, s: 30 });
        issues.push({
          noteId: n.id,
          kind: 'broke-line',
          amount: unvoicedRun,
          text: `The line broke before ${label(n, semis)}; keep it connected`,
          severity: 0.4,
        });
      }
    }
  }
  // break inside a long note
  for (const n of notes) {
    if (n.end - n.start < 0.8) continue;
    const inside = frames.filter((f) => f.t >= n.start + 0.1 && f.t <= n.end - 0.1);
    const res = results.find((r) => r.noteId === n.id);
    if (!res || res.status === 'missed') continue;
    const unv = longestUnvoiced(inside, voiced);
    if (unv >= 0.25) {
      exprScores.push({ w: 0.5, s: 30 });
      issues.push({
        noteId: n.id,
        kind: 'broke-line',
        amount: unv,
        text: `${label(n, semis)} broke up mid-note; support it with steady breath`,
        severity: 0.45,
      });
    }
  }

  const agg = (arr: { w: number; s: number }[]): number | null => {
    const W = arr.reduce((a, b) => a + b.w, 0);
    if (W === 0) return null;
    return arr.reduce((a, b) => a + b.w * b.s, 0) / W;
  };
  const pitch = agg(pitchScores) ?? 0;
  const timing = agg(timingScores) ?? pitch;
  const length = agg(lengthScores) ?? Math.max(pitch, timing);
  const exprRaw = agg(exprScores);
  const expression = exprRaw ?? (pitch + timing) / 2;
  const weights = exprRaw === null ? { p: 0.6, t: 0.22, l: 0.18, e: 0 } : { p: 0.5, t: 0.2, l: 0.15, e: 0.15 };
  const overall = pitch * weights.p + timing * weights.t + length * weights.l + expression * weights.e;
  const scores: CriterionScore = {
    pitch: Math.round(pitch),
    timing: Math.round(timing),
    length: Math.round(length),
    expression: Math.round(expression),
    overall: Math.round(overall),
  };
  issues.sort((a, b) => b.severity - a.severity);
  // order the per-note results like the notes
  results.sort((a, b) => a.noteId - b.noteId);
  const tip = pickTip(issues, scores, notes.length);
  return { scores, issues, noteResults: results, tip };
}

function longestUnvoiced(fs: PitchFrame[], voiced: (f: PitchFrame) => boolean): number {
  let best = 0;
  let runStart: number | null = null;
  for (let i = 0; i < fs.length; i++) {
    if (!voiced(fs[i])) {
      if (runStart === null) runStart = fs[i].t;
      best = Math.max(best, fs[i].t - runStart);
    } else runStart = null;
  }
  return best;
}

const TIPS: Record<IssueKind, Tip> = {
  flat: {
    title: 'You are landing under the notes',
    detail: 'Think of each note as sitting slightly higher than you expect, and give it a little more breath energy. Play "Listen" first, hum the guide tone, then sing with the guide tone on until it feels effortless.',
    exerciseId: 'pitch-match',
  },
  sharp: {
    title: 'You are pushing over the pitch',
    detail: 'Sharp notes usually come from tension: drop your shoulders, relax the jaw and sing a touch softer. Aim for the centre of the guide tone instead of reaching above it.',
    exerciseId: 'pitch-match',
  },
  octave: {
    title: 'You sang in a different octave',
    detail: 'That is fine if it is comfortable, but the song feels different. If the original octave is out of reach, lower the key with the key selector instead.',
    exerciseId: 'range-extension',
  },
  late: {
    title: 'Come in earlier',
    detail: 'Breathe during the pre-roll and start the vowel exactly on the note, not after it. Slow the phrase to 70% and sing with the guide tone until the entries line up.',
    exerciseId: 'onset-precision',
  },
  early: {
    title: 'You are rushing the entries',
    detail: 'Wait for the note to start. Count the pre-roll out loud once, then sing it again at 85% speed.',
    exerciseId: 'onset-precision',
  },
  short: {
    title: 'Hold the notes their full length',
    detail: 'Keep the air flowing to the very end of each note. Take a lower, fuller breath before the phrase so you have enough left for the long notes.',
    exerciseId: 'sustain',
  },
  long: {
    title: 'Release the note on time',
    detail: 'Cut the note where the singer does so the phrase keeps its shape.',
    exerciseId: 'onset-precision',
  },
  missed: {
    title: 'Learn the melody first',
    detail: 'Play "Listen" and hum along with the guide tone a few times at 70% speed. Then sing it with the guide tone on before trying it with the band alone.',
    exerciseId: 'pitch-match',
  },
  unstable: {
    title: 'Steady the long notes',
    detail: 'Keep a constant stream of air and do not change the vowel while you hold. A steady "ssss" before singing helps you feel the support you need.',
    exerciseId: 'sustain',
  },
  'no-slide': {
    title: 'Slide into the note',
    detail: 'The singer glides into this note. Start on the lower pitch and slide smoothly up to the target instead of jumping straight to it.',
    exerciseId: 'sirens',
  },
  'no-vibrato': {
    title: 'Let the long notes bloom',
    detail: 'Hold the note straight for a moment, then let a gentle wave in. Vibrato comes from a relaxed throat and steady breath, never from pushing.',
    exerciseId: 'vibrato',
  },
  'too-soft': {
    title: 'Shape the dynamics',
    detail: 'This phrase has a louder moment. Lean into it with more breath, not more throat.',
    exerciseId: 'dynamics',
  },
  'too-loud': {
    title: 'Shape the dynamics',
    detail: 'This phrase has a softer moment. Back off the volume there while keeping the tone focused.',
    exerciseId: 'dynamics',
  },
  'no-breath': {
    title: 'Breathe where the singer breathes',
    detail: 'The original takes a breath here. Plan your breaths at the same places; it keeps the phrasing natural and gives you air for what follows.',
    exerciseId: 'breathing',
  },
  'broke-line': {
    title: 'Keep the line connected',
    detail: 'You ran out of air or let the tone drop mid-phrase. Take a deeper, lower breath before the phrase and spend it evenly.',
    exerciseId: 'breath-support',
  },
  strain: {
    title: 'Ease off, you are straining',
    detail: 'Those high notes sound pushed. Lower the key for now and build up with sirens; never force a note that hurts.',
    exerciseId: 'sirens',
  },
};

export function tipFor(kind: IssueKind): Tip {
  return TIPS[kind];
}

export function pickTip(issues: NoteIssue[], scores: CriterionScore, noteCount: number): Tip {
  if (issues.length === 0) {
    return scores.overall >= 90
      ? { title: 'Excellent, that phrase is yours', detail: 'Move on to the next phrase, or run the whole song to put them together.', exerciseId: null }
      : { title: 'Solid. Polish the details', detail: 'Nothing was clearly wrong. Sing it once more and listen for the exact note endings and the breath spots.', exerciseId: null };
  }
  const totals = new Map<IssueKind, number>();
  for (const i of issues) totals.set(i.kind, (totals.get(i.kind) ?? 0) + i.severity);
  const missed = totals.get('missed') ?? 0;
  if (missed >= Math.max(1, noteCount * 0.25)) return TIPS.missed;
  let bestKind: IssueKind = issues[0].kind;
  let best = -1;
  for (const [k, v] of totals) {
    if (v > best) {
      best = v;
      bestKind = k;
    }
  }
  return TIPS[bestKind];
}

/** Colour class for a live pitch error in cents. */
export function accuracyClass(cents: number | null, level: Level): 'on' | 'near' | 'off' | 'none' {
  if (cents === null || isNaN(cents)) return 'none';
  const t = tolerances(level).cents;
  const a = Math.abs(cents);
  if (a <= t) return 'on';
  if (a <= t * 2) return 'near';
  return 'off';
}
