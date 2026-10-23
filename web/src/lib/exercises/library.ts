import type { Level, Profile, RefNote, SongAnalysis, Goal } from '../types';
import { midiToHz, nameToMidi, clamp } from '../music/notes';
import { buildPhrases, dynamicFor } from '../analysis/segment';

export type ExerciseCategory = 'breathing' | 'pitch' | 'range' | 'tone' | 'rhythm' | 'expression';

export interface NoteSpec {
  midi: number;
  start: number;
  end: number;
  slideFrom?: number;
  vibrato?: { rate: number; extentCents: number };
  loudnessDb?: number;
  lyric?: string;
}

export type ExercisePlan =
  | { kind: 'pitched'; analysis: SongAnalysis; guideGain: number; drone: number | null; cue: string }
  | { kind: 'breathing'; steps: { label: string; seconds: number }[]; rounds: number; cue: string }
  | { kind: 'hiss'; targetSeconds: number; cue: string };

export interface Exercise {
  id: string;
  name: string;
  category: ExerciseCategory;
  minutes: number;
  summary: string;
  how: string[];
  trains: string[];
  build: (profile: Profile) => ExercisePlan;
}

function range(profile: Profile): { low: number; high: number; mid: number } {
  const last = profile.rangeTests[profile.rangeTests.length - 1];
  const low = last ? last.lowMidi : nameToMidi('A2');
  const high = last ? last.highMidi : nameToMidi('A4');
  return { low, high, mid: Math.round((low + high) / 2) };
}

function speed(level: Level): number {
  return level === 'beginner' ? 1 : level === 'intermediate' ? 0.8 : 0.65; // seconds per step
}

/** Build a synthetic reference analysis from a list of notes. */
export function analysisFromNotes(specs: NoteSpec[], tail = 0.5): SongAnalysis {
  const hop = 0.01;
  const duration = (specs.length ? Math.max(...specs.map((s) => s.end)) : 0) + tail;
  const n = Math.ceil(duration / hop);
  const hz = new Array<number>(n).fill(0);
  const rmsDb = new Array<number>(n).fill(-100);
  const notes: RefNote[] = specs.map((s, i) => ({
    id: i,
    start: s.start,
    end: s.end,
    midi: s.midi,
    cents: 0,
    hzMedian: midiToHz(s.midi),
    stabilityCents: 0,
    slideIn: s.slideFrom !== undefined ? { fromMidi: s.slideFrom, duration: Math.min(0.3, (s.end - s.start) * 0.5) } : null,
    run: false,
    vibrato: s.vibrato ?? null,
    loudnessDb: s.loudnessDb ?? -3,
    dynamic: dynamicFor(s.loudnessDb ?? -3),
    breathBefore: false,
    register: null,
    lyric: s.lyric ?? null,
    phrase: 0,
  }));
  for (const s of specs) {
    const a = Math.floor(s.start / hop);
    const b = Math.min(n, Math.ceil(s.end / hop));
    for (let k = a; k < b; k++) {
      let m = s.midi;
      if (s.slideFrom !== undefined) {
        const gl = Math.min(0.3, (s.end - s.start) * 0.5);
        const t = (k * hop - s.start) / gl;
        if (t < 1) m = s.slideFrom + (s.midi - s.slideFrom) * clamp(t, 0, 1);
      }
      hz[k] = midiToHz(m);
      rmsDb[k] = s.loudnessDb ?? -3;
    }
  }
  const { phrases, breaths } = buildPhrases(notes, duration);
  const midis = specs.map((s) => s.midi);
  return {
    version: 1,
    mode: 'separated',
    duration,
    key: null,
    tempoBpm: null,
    melody: { t0: 0, hop, hz, rmsDb },
    notes,
    phrases,
    breaths,
    range: { lowMidi: Math.min(...midis), highMidi: Math.max(...midis), p05: Math.min(...midis), p95: Math.max(...midis) },
    warnings: [],
  };
}

function seq(start: number, midis: number[], step: number, gap = 0): { specs: NoteSpec[]; end: number } {
  const specs: NoteSpec[] = [];
  let t = start;
  for (const m of midis) {
    specs.push({ midi: m, start: t, end: t + step - gap });
    t += step;
  }
  return { specs, end: t };
}

function glide(start: number, from: number, to: number, seconds: number): { specs: NoteSpec[]; end: number } {
  const steps = Math.abs(to - from);
  const dir = Math.sign(to - from);
  const per = seconds / Math.max(1, steps);
  const specs: NoteSpec[] = [];
  for (let i = 0; i <= steps; i++) {
    const m = from + dir * i;
    specs.push({ midi: m, start: start + i * per, end: start + (i + 1) * per, slideFrom: i === 0 ? undefined : m - dir });
  }
  return { specs, end: start + (steps + 1) * per };
}

export const EXERCISES: Exercise[] = [
  {
    id: 'breathing',
    name: 'Low breathing',
    category: 'breathing',
    minutes: 3,
    summary: 'Slow, low breaths to switch on your support before singing.',
    how: ['Sit or stand tall, one hand on your belly.', 'Breathe in through the nose; the belly moves out, shoulders stay still.', 'Breathe out on a thin, even stream of air.'],
    trains: ['breath control', 'calm phrasing', 'breath points'],
    build: (p) => ({
      kind: 'breathing',
      cue: 'Follow the circle. Belly out on the way in, shoulders still.',
      steps:
        p.level === 'beginner'
          ? [
              { label: 'Breathe in', seconds: 4 },
              { label: 'Hold', seconds: 4 },
              { label: 'Breathe out', seconds: 4 },
              { label: 'Rest', seconds: 2 },
            ]
          : [
              { label: 'Breathe in', seconds: 4 },
              { label: 'Hold', seconds: 6 },
              { label: 'Breathe out on "ssss"', seconds: 8 },
              { label: 'Rest', seconds: 2 },
            ],
      rounds: 4,
    }),
  },
  {
    id: 'breath-support',
    name: 'Long hiss',
    category: 'breathing',
    minutes: 3,
    summary: 'Hiss on one steady stream of air for as long as you can. Trains the support long notes need.',
    how: ['Take a low breath.', 'Hiss "ssss" at a steady, medium volume.', 'Keep the volume even to the very end; stop before you squeeze.'],
    trains: ['breath support', 'long notes', 'connected lines'],
    build: (p) => ({
      kind: 'hiss',
      cue: 'Hiss steadily. The bar fills while your air stream stays even.',
      targetSeconds: p.level === 'beginner' ? 15 : p.level === 'intermediate' ? 25 : 35,
    }),
  },
  {
    id: 'pitch-match',
    name: 'Match the note',
    category: 'pitch',
    minutes: 4,
    summary: 'Hear a note, sing it back. The foundation of singing in tune.',
    how: ['Listen to the tone.', 'Sing it back on "oo" and hold it steady.', 'Watch the meter: green means you are on it.'],
    trains: ['pitch accuracy', 'listening'],
    build: (p) => {
      const r = range(p);
      const lo = r.low + 3;
      const hi = r.high - 3;
      const specs: NoteSpec[] = [];
      let t = 0.5;
      const count = p.level === 'beginner' ? 8 : 10;
      let prev = r.mid;
      for (let i = 0; i < count; i++) {
        const maxLeap = p.level === 'beginner' ? 4 : p.level === 'intermediate' ? 7 : 12;
        let m = prev + Math.round((Math.random() * 2 - 1) * maxLeap);
        m = clamp(m, lo, hi);
        specs.push({ midi: m, start: t, end: t + 1.6, lyric: 'oo' });
        prev = m;
        t += 2.6;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.35, drone: null, cue: 'Listen to each tone, then sing it back and hold it.' };
    },
  },
  {
    id: 'scales',
    name: 'Five-note scales',
    category: 'pitch',
    minutes: 5,
    summary: 'Up and down five notes, moving through your range.',
    how: ['Sing on "ah" or "ee".', 'Stay light; let the top notes be easy, not loud.', 'Keep every note the same length.'],
    trains: ['pitch accuracy', 'steps between notes', 'evenness'],
    build: (p) => {
      const r = range(p);
      const step = speed(p.level) * 0.5;
      const specs: NoteSpec[] = [];
      let t = 0.5;
      const reps = p.level === 'beginner' ? 4 : 6;
      let root = clamp(r.mid - 6, r.low, r.high - 7);
      for (let i = 0; i < reps; i++) {
        const pattern = [0, 2, 4, 5, 7, 5, 4, 2, 0].map((x) => root + x);
        const s = seq(t, pattern, step, 0.02);
        s.specs[s.specs.length - 1].end += step * 0.8;
        specs.push(...s.specs);
        t = s.end + step * 0.8 + 1.0;
        root += 2;
        if (root + 7 > r.high) root = clamp(r.mid - 8, r.low, r.high - 7);
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.3, drone: null, cue: 'Sing with the guide tones. Even notes, easy top.' };
    },
  },
  {
    id: 'sirens',
    name: 'Sirens',
    category: 'range',
    minutes: 4,
    summary: 'Smooth slides from low to high and back on "oo". Frees the voice and connects your range.',
    how: ['Start low and soft on "oo" like a siren.', 'Slide smoothly up to the top and back down, no bumps.', 'Let the sound get lighter as it rises.'],
    trains: ['slides', 'range', 'register transitions'],
    build: (p) => {
      const r = range(p);
      const specs: NoteSpec[] = [];
      let t = 0.5;
      const reps = 4;
      const span = p.level === 'beginner' ? Math.min(9, r.high - r.low - 2) : Math.min(14, r.high - r.low - 1);
      for (let i = 0; i < reps; i++) {
        const from = clamp(r.low + 2 + i, r.low, r.high - span);
        const up = glide(t, from, from + span, 2.2);
        const down = glide(up.end, from + span, from, 2.2);
        specs.push(...up.specs, ...down.specs);
        t = down.end + 1.2;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.25, drone: null, cue: 'Slide with the guide, smooth like a siren. Lighter as you go up.' };
    },
  },
  {
    id: 'lip-trills',
    name: 'Lip trills',
    category: 'tone',
    minutes: 3,
    summary: 'Buzz your lips on a slide. The best warm-up for breath flow and an easy top.',
    how: ['Let your lips flap loosely like a motorboat; use fingers on your cheeks if they tense up.', 'Follow the slide with the buzz.', 'If the buzz stops, you are pushing too much air or too little.'],
    trains: ['breath flow', 'relaxed tone', 'range'],
    build: (p) => {
      const r = range(p);
      const specs: NoteSpec[] = [];
      let t = 0.5;
      const span = Math.min(12, Math.max(5, r.high - r.low - 3));
      for (let i = 0; i < 4; i++) {
        const from = clamp(r.low + 1 + i * 2, r.low, r.high - span);
        const up = glide(t, from, from + span, 1.8);
        const down = glide(up.end, from + span, from, 1.8);
        specs.push(...up.specs, ...down.specs);
        t = down.end + 1.2;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.25, drone: null, cue: 'Lip trill along the slide. Keep the buzz going the whole way.' };
    },
  },
  {
    id: 'sustain',
    name: 'Long tones',
    category: 'tone',
    minutes: 4,
    summary: 'Hold one note straight and steady. Trains stability and note length.',
    how: ['Breathe low, then sing one note on "ah".', 'Keep pitch and volume completely still.', 'Finish the note cleanly instead of fading out early.'],
    trains: ['note length', 'stability', 'breath support'],
    build: (p) => {
      const r = range(p);
      const len = p.level === 'beginner' ? 5 : p.level === 'intermediate' ? 7 : 9;
      const specs: NoteSpec[] = [];
      let t = 0.5;
      for (const m of [r.mid - 2, r.mid + 1, r.mid + 4, r.mid - 4]) {
        specs.push({ midi: clamp(m, r.low, r.high), start: t, end: t + len, lyric: 'ah' });
        t += len + 3;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.2, drone: null, cue: 'One steady note. Pitch and volume still until the end.' };
    },
  },
  {
    id: 'range-extension',
    name: 'Reach higher',
    category: 'range',
    minutes: 5,
    summary: 'Short 1-2-3-2-1 patterns climbing a semitone each time, near the top of your range.',
    how: ['Stay light and bright; think "small" at the top.', 'Stop the moment it feels tight or hurts.', 'A good day adds one semitone, not five.'],
    trains: ['high notes', 'range'],
    build: (p) => {
      const r = range(p);
      const step = speed(p.level) * 0.45;
      const specs: NoteSpec[] = [];
      let t = 0.5;
      let root = r.high - 6;
      for (let i = 0; i < 6; i++) {
        const s = seq(t, [0, 2, 4, 2, 0].map((x) => root + x), step, 0.02);
        s.specs[s.specs.length - 1].end += step;
        specs.push(...s.specs);
        t = s.end + step + 1.4;
        root += 1;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.3, drone: null, cue: 'Light and easy. Stop if it tightens.' };
    },
  },
  {
    id: 'register-transitions',
    name: 'Chest to head',
    category: 'range',
    minutes: 5,
    summary: 'Octave slides across the break, up and down, to smooth the switch between chest and head voice.',
    how: ['Start in a comfortable chest note on "oo".', 'Slide an octave up, letting the voice flip lighter without a bump.', 'Slide back down and let it fill out again.'],
    trains: ['register transitions', 'mixed voice'],
    build: (p) => {
      const r = range(p);
      const specs: NoteSpec[] = [];
      let t = 0.5;
      for (let i = 0; i < 4; i++) {
        const from = clamp(r.mid - 7 + i, r.low, r.high - 12);
        const up = glide(t, from, from + 12, 2.4);
        const hold: NoteSpec = { midi: from + 12, start: up.end, end: up.end + 1.2 };
        const down = glide(hold.end, from + 12, from, 2.4);
        specs.push(...up.specs, hold, ...down.specs);
        t = down.end + 1.5;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.25, drone: null, cue: 'Slide the octave smoothly. Lighter up, fuller down.' };
    },
  },
  {
    id: 'onset-precision',
    name: 'On the beat',
    category: 'rhythm',
    minutes: 3,
    summary: 'Short notes exactly on the beat. Trains clean, on-time entries.',
    how: ['Each note starts with the guide tone, not after it.', 'Breathe in the gaps.', 'Keep the notes short and clean.'],
    trains: ['timing', 'entries'],
    build: (p) => {
      const r = range(p);
      const beat = p.level === 'beginner' ? 0.75 : 0.6;
      const specs: NoteSpec[] = [];
      let t = 1.0;
      const pattern = [0, 0, 4, 4, 7, 7, 4, 4, 0, 0, 2, 2, 4, 4, 0, 0];
      for (const x of pattern) {
        specs.push({ midi: clamp(r.mid - 3 + x, r.low, r.high), start: t, end: t + beat * 0.5, lyric: 'ta' });
        t += beat;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.35, drone: null, cue: 'Short "ta" exactly with each tone.' };
    },
  },
  {
    id: 'vibrato',
    name: 'Vibrato waves',
    category: 'expression',
    minutes: 4,
    summary: 'Hold a note straight, then let a gentle 5–6 waves-per-second wobble in.',
    how: ['Hold the note straight for two seconds.', 'Pulse the pitch gently from the diaphragm, like a slow laugh, then let it even out.', 'Never shake the jaw or the throat.'],
    trains: ['vibrato', 'relaxed sustain'],
    build: (p) => {
      const r = range(p);
      const specs: NoteSpec[] = [];
      let t = 0.5;
      for (const m of [r.mid, r.mid + 3, r.mid - 2]) {
        specs.push({ midi: clamp(m, r.low, r.high), start: t, end: t + 5, vibrato: { rate: 5.5, extentCents: 40 }, lyric: 'ah' });
        t += 7;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.2, drone: null, cue: 'Straight first, then let the wave in.' };
    },
  },
  {
    id: 'dynamics',
    name: 'Soft, loud, soft',
    category: 'expression',
    minutes: 4,
    summary: 'One note that grows from soft to loud and back, without the pitch moving.',
    how: ['Start soft but clear.', 'Grow the sound with more air, not a tighter throat.', 'Come back down to soft while keeping the pitch still.'],
    trains: ['dynamics', 'control'],
    build: (p) => {
      const r = range(p);
      const specs: NoteSpec[] = [];
      let t = 0.5;
      for (const m of [r.mid - 1, r.mid + 2]) {
        const mm = clamp(m, r.low, r.high);
        specs.push({ midi: mm, start: t, end: t + 2, loudnessDb: -16, lyric: 'soft' });
        specs.push({ midi: mm, start: t + 2, end: t + 4, loudnessDb: -2, lyric: 'loud' });
        specs.push({ midi: mm, start: t + 4, end: t + 6, loudnessDb: -16, lyric: 'soft' });
        t += 8;
      }
      return { kind: 'pitched', analysis: analysisFromNotes(specs), guideGain: 0.2, drone: null, cue: 'Soft, grow to loud, back to soft. Pitch stays put.' };
    },
  },
];

export function exerciseById(id: string | null | undefined): Exercise | undefined {
  return EXERCISES.find((e) => e.id === id);
}

/** Daily warm-up set tailored to level and goals. */
export function warmupFor(level: Level, goals: Goal[]): Exercise[] {
  const ids = ['breathing', 'lip-trills', 'sirens', 'pitch-match'];
  if (level !== 'beginner') ids.push('scales');
  if (goals.includes('range')) ids.push('range-extension');
  if (goals.includes('technique')) ids.push('register-transitions');
  if (level === 'advanced') ids.push('vibrato');
  return ids.map((id) => exerciseById(id)!).filter(Boolean);
}

/** Exercise suggested for a difficult phrase, from its tags. */
export function exerciseForTags(tags: string[]): Exercise | null {
  if (tags.includes('high-note')) return exerciseById('range-extension')!;
  if (tags.includes('long-hold')) return exerciseById('sustain')!;
  if (tags.includes('run') || tags.includes('fast')) return exerciseById('scales')!;
  if (tags.includes('wide-leap')) return exerciseById('register-transitions')!;
  if (tags.includes('slide')) return exerciseById('sirens')!;
  if (tags.includes('vibrato')) return exerciseById('vibrato')!;
  return null;
}
