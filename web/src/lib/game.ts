// Karaoke game scoring: pure, deterministic logic fed with live pitch frames. No DOM.
//
// Points: every on-pitch frame earns 10 × note weight × multiplier (near-pitch frames earn half).
// Combo: counts notes hit in a row; it breaks when the singer is off pitch (or silent) for more
// than 0.3 s while a note is playing, or misses a note. Multiplier: ×1 → ×4, one step every 5 combo.
// Score (0..100): on-pitch ratio weighted by note duration, the same for each phrase.

import type { GameResult, Level, PitchFrame, SongAnalysis } from './types';
import { tolerances } from './scoring/score';
import { clamp } from './music/notes';

export interface KaraokeOptions {
  semitones: number;
  level: Level;
  tempo: number;
  /** Accept singing in another octave (default true). */
  allowOctave?: boolean;
}

export interface KaraokeState {
  points: number;
  combo: number;
  maxCombo: number;
  multiplier: number;
  /** Weighted on-pitch ratio so far, 0..1 (near-pitch counts half). */
  onPitchRatio: number;
  /** Index of the note under the last fed frame, or null between notes. */
  noteId: number | null;
  phraseIndex: number | null;
  /** Cents error of the last voiced frame against its note, or null. */
  cents: number | null;
  /** Phrases already finished, with their stars. */
  phrasesDone: { phraseIndex: number; score: number; stars: number }[];
}

/** Events the UI may react to (stars popping, combo breaks). */
export type KaraokeEvent =
  | { type: 'phrase'; phraseIndex: number; score: number; stars: number }
  | { type: 'combo-break'; combo: number }
  | { type: 'multiplier'; multiplier: number };

export type GameOutcome = Omit<GameResult, 'id' | 'songId' | 'date'>;

export const COMBO_BREAK_SECONDS = 0.3;
export const MAX_MULTIPLIER = 4;
export const COMBO_PER_MULTIPLIER = 5;
export const POINTS_PER_FRAME = 10;
/** A note counts as "hit" (combo +1) when at least this share of its frames were on or near pitch. */
export const NOTE_HIT_RATIO = 0.6;

/** Stars for a 0..100 score: ≥ 95 → 5, ≥ 85 → 4, ≥ 70 → 3, ≥ 55 → 2, ≥ 35 → 1. */
export function starsFor(score: number): number {
  if (!isFinite(score)) return 0;
  if (score >= 95) return 5;
  if (score >= 85) return 4;
  if (score >= 70) return 3;
  if (score >= 55) return 2;
  if (score >= 35) return 1;
  return 0;
}

export function multiplierFor(combo: number): number {
  return Math.min(MAX_MULTIPLIER, 1 + Math.floor(Math.max(0, combo) / COMBO_PER_MULTIPLIER));
}

interface NoteTally {
  weight: number; // duration weight
  frames: number; // frames seen while the note was active
  credit: number; // on-pitch = 1, near = 0.5
  done: boolean; // tallied into the combo
}

export class KaraokeScorer {
  private readonly notes: SongAnalysis['notes'];
  private readonly phrases: SongAnalysis['phrases'];
  private readonly tolCents: number;
  private readonly allowOctave: boolean;
  private readonly tally: NoteTally[];
  private readonly phraseDone: Set<number> = new Set();
  private readonly phraseResults = new Map<number, { score: number; stars: number }>();
  private pointsF = 0;
  private combo = 0;
  private maxCombo = 0;
  private offSince: number | null = null; // song time when the singer went off pitch during a note
  private firstOpen = 0; // every note before this index has been tallied
  private lastNote: number | null = null;
  private lastCents: number | null = null;
  private cursor = 0; // notes are sorted; frames mostly arrive in order
  private creditSum = 0; // weighted on-pitch credit over fed frames
  private frameSum = 0; // weighted frames while a note was active

  constructor(analysis: SongAnalysis, private readonly opts: KaraokeOptions) {
    this.notes = analysis.notes;
    this.phrases = analysis.phrases;
    this.tolCents = tolerances(opts.level).cents;
    this.allowOctave = opts.allowOctave ?? true;
    this.tally = this.notes.map((n) => ({ weight: clamp(n.end - n.start, 0.15, 2.5), frames: 0, credit: 0, done: false }));
  }

  /** Reference note active at song time t (start ≤ t < end), or -1. */
  private noteAt(t: number): number {
    const ns = this.notes;
    if (ns.length === 0) return -1;
    // fast path: the cursor and its neighbours
    for (let i = Math.max(0, this.cursor - 1); i < Math.min(ns.length, this.cursor + 3); i++) {
      if (t >= ns[i].start && t < ns[i].end) {
        this.cursor = i;
        return i;
      }
    }
    // binary search on start
    let lo = 0;
    let hi = ns.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ns[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    if (t >= ns[lo].start && t < ns[lo].end) {
      this.cursor = lo;
      return lo;
    }
    this.cursor = lo;
    return -1;
  }

  private centsOff(frame: PitchFrame, noteIdx: number): number | null {
    if (!(frame.hz > 0) || !(frame.clarity > 0.5) || !isFinite(frame.midi)) return null;
    const n = this.notes[noteIdx];
    const target = n.midi + this.opts.semitones + n.cents / 100;
    let err = frame.midi - target;
    if (this.allowOctave) err -= 12 * Math.round(err / 12);
    return err * 100;
  }

  /** Feed one live frame (song time). Returns events for the UI, in order. */
  feed(frame: PitchFrame): KaraokeEvent[] {
    const events: KaraokeEvent[] = [];
    const t = frame.t;
    if (!isFinite(t)) return events;
    // notes whose end we have passed are tallied once (also closes notes skipped by a seek)
    this.closeNotesBefore(t, events);
    const idx = this.noteAt(t);
    if (idx < 0) {
      this.lastNote = null;
      this.lastCents = null;
      // rests never break a combo
      this.offSince = null;
      return events;
    }
    const tl = this.tally[idx];
    const cents = this.centsOff(frame, idx);
    this.lastNote = idx;
    this.lastCents = cents;
    const a = cents === null ? Infinity : Math.abs(cents);
    const credit = a <= this.tolCents ? 1 : a <= this.tolCents * 2 ? 0.5 : 0;
    tl.frames++;
    tl.credit += credit;
    this.frameSum += tl.weight;
    this.creditSum += tl.weight * credit;
    const multBefore = multiplierFor(this.combo);
    if (credit > 0) {
      this.offSince = null;
      this.pointsF += POINTS_PER_FRAME * tl.weight * multiplierFor(this.combo) * credit;
    } else {
      if (this.offSince === null) this.offSince = t;
      else if (t - this.offSince > COMBO_BREAK_SECONDS && this.combo > 0) {
        events.push({ type: 'combo-break', combo: this.combo });
        this.combo = 0;
      }
    }
    const multAfter = multiplierFor(this.combo);
    if (multAfter !== multBefore) events.push({ type: 'multiplier', multiplier: multAfter });
    return events;
  }

  private closeNotesBefore(t: number, events: KaraokeEvent[]) {
    const ns = this.notes;
    while (this.firstOpen < ns.length && this.tally[this.firstOpen].done) this.firstOpen++;
    for (let i = this.firstOpen; i < ns.length; i++) {
      const tl = this.tally[i];
      if (tl.done) continue;
      if (ns[i].end > t) {
        // notes are sorted by start but may overlap slightly; stop at the first that is still playing
        if (ns[i].start > t) break;
        continue;
      }
      tl.done = true;
      const ratio = tl.frames > 0 ? tl.credit / tl.frames : 0;
      const multBefore = multiplierFor(this.combo);
      if (tl.frames > 0 && ratio >= NOTE_HIT_RATIO) {
        this.combo++;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
      } else if (this.combo > 0) {
        events.push({ type: 'combo-break', combo: this.combo });
        this.combo = 0;
      }
      const multAfter = multiplierFor(this.combo);
      if (multAfter !== multBefore) events.push({ type: 'multiplier', multiplier: multAfter });
      // phrase finished?
      const pi = ns[i].phrase;
      const ph = this.phrases[pi];
      if (ph && !this.phraseDone.has(pi) && ph.noteIds.every((id) => this.tally[id]?.done)) {
        this.phraseDone.add(pi);
        const r = this.phraseScore(pi);
        this.phraseResults.set(pi, r);
        events.push({ type: 'phrase', phraseIndex: pi, ...r });
      }
    }
  }

  private phraseScore(pi: number): { score: number; stars: number } {
    const ph = this.phrases[pi];
    let W = 0;
    let C = 0;
    for (const id of ph.noteIds) {
      const tl = this.tally[id];
      if (!tl) continue;
      W += tl.weight;
      C += tl.weight * (tl.frames > 0 ? tl.credit / tl.frames : 0);
    }
    const score = W > 0 ? Math.round((C / W) * 100) : 0;
    return { score, stars: starsFor(score) };
  }

  get state(): KaraokeState {
    const idx = this.lastNote;
    return {
      points: Math.floor(this.pointsF),
      combo: this.combo,
      maxCombo: this.maxCombo,
      multiplier: multiplierFor(this.combo),
      onPitchRatio: this.frameSum > 0 ? this.creditSum / this.frameSum : 0,
      noteId: idx === null ? null : this.notes[idx].id,
      phraseIndex: idx === null ? null : this.notes[idx].phrase,
      cents: this.lastCents,
      phrasesDone: [...this.phraseResults.entries()].sort((a, b) => a[0] - b[0]).map(([phraseIndex, r]) => ({ phraseIndex, ...r })),
    };
  }

  /** Stars already awarded to a phrase (0 when it has not finished). */
  starsForPhrase(phraseIndex: number): number {
    return this.phraseResults.get(phraseIndex)?.stars ?? 0;
  }

  /**
   * Close the game: every remaining note is tallied (unsung notes score 0) and the result is
   * returned without id/songId/date, which the caller fills in.
   */
  finish(): GameOutcome {
    const events: KaraokeEvent[] = [];
    this.closeNotesBefore(Infinity, events);
    const perPhrase = this.phrases.map((ph) => {
      const r = this.phraseResults.get(ph.index) ?? this.phraseScore(ph.index);
      return { phraseIndex: ph.index, score: r.score, stars: r.stars };
    });
    // overall: duration-weighted over every note of the song (unsung notes count as 0)
    let W = 0;
    let C = 0;
    for (const tl of this.tally) {
      W += tl.weight;
      C += tl.weight * (tl.frames > 0 ? tl.credit / tl.frames : 0);
    }
    const score = W > 0 ? Math.round((C / W) * 100) : 0;
    return {
      score,
      points: Math.floor(this.pointsF),
      stars: starsFor(score),
      maxCombo: this.maxCombo,
      semitones: this.opts.semitones,
      tempo: this.opts.tempo,
      perPhrase,
    };
  }
}

/** Best previous result for a song, or null. */
export function bestGame(results: GameResult[], songId: string): GameResult | null {
  let best: GameResult | null = null;
  for (const r of results) {
    if (r.songId !== songId) continue;
    if (!best || r.points > best.points || (r.points === best.points && r.score > best.score)) best = r;
  }
  return best;
}
