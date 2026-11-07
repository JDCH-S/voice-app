// Spaced review (SM-2-lite) for song phrases, plus the "then vs now" helper.
// Pure functions; `now` is always passed in so they are testable.

import type { Mastery, RecordingRecord, ReviewState } from './types';
import { clamp } from './music/notes';

export const DAY_MS = 86400000;
/** Review ladder in days. A score < 70 drops back to the first rung. */
export const REVIEW_LADDER = [1, 3, 7, 14, 30] as const;
export const MAX_INTERVAL_DAYS = 45;
export const RESET_BELOW = 70;

const MASTERY_RANK: Record<Mastery, number> = { new: 0, learning: 1, learned: 2, mastered: 3 };

function masteryAfter(score: number, intervalDays: number, bestScore: number): Mastery {
  if (score >= 90 && intervalDays >= 14) return 'mastered';
  if (score >= 85 && intervalDays >= 7 && bestScore >= 90) return 'mastered';
  if (score >= 75 && intervalDays >= 3) return 'learned';
  return 'learning';
}

/** Next rung of the ladder after `intervalDays`. */
export function nextRung(intervalDays: number): number {
  for (const d of REVIEW_LADDER) if (d > intervalDays + 1e-9) return d;
  return REVIEW_LADDER[REVIEW_LADDER.length - 1];
}

/**
 * Update the review state of a phrase after a scored attempt.
 * Intervals climb 1 → 3 → 7 → 14 → 30 days and are scaled by the score
 * (70 → ×0.75, 85 → ×1, 100 → ×1.25); a score under 70 resets to 1 day.
 */
export function updateReview(prev: ReviewState | null, score: number, now: number, ids?: { songId: string; phraseIndex: number }): ReviewState {
  const songId = prev?.songId ?? ids?.songId ?? '';
  const phraseIndex = prev?.phraseIndex ?? ids?.phraseIndex ?? 0;
  const s = clamp(Math.round(score), 0, 100);
  const bestScore = Math.max(prev?.bestScore ?? 0, s);
  let intervalDays: number;
  if (s < RESET_BELOW) {
    intervalDays = 1;
  } else {
    const rung = prev ? nextRung(prev.intervalDays) : REVIEW_LADDER[0];
    const scale = 0.75 + ((s - RESET_BELOW) / (100 - RESET_BELOW)) * 0.5;
    intervalDays = clamp(Math.round(rung * scale * 10) / 10, 1, MAX_INTERVAL_DAYS);
  }
  const mastery: Mastery = s < RESET_BELOW ? 'learning' : masteryAfter(s, intervalDays, bestScore);
  return {
    songId,
    phraseIndex,
    mastery,
    bestScore,
    lastScore: s,
    lastPracticed: now,
    dueAt: now + intervalDays * DAY_MS,
    intervalDays,
  };
}

/** Days a review is overdue (negative = not yet due). */
export function overdueDays(state: ReviewState, now: number): number {
  return (now - state.dueAt) / DAY_MS;
}

/**
 * Reviews that are due at `now`, most urgent first: most overdue and lowest mastery win,
 * then the lower last score.
 */
export function dueReviews(states: ReviewState[], now: number, limit = 3): ReviewState[] {
  const due = states.filter((s) => s.dueAt <= now);
  const prio = (s: ReviewState) => overdueDays(s, now) + (3 - MASTERY_RANK[s.mastery]) * 2;
  due.sort((a, b) => {
    const d = prio(b) - prio(a);
    if (Math.abs(d) > 1e-9) return d;
    if (a.lastScore !== b.lastScore) return a.lastScore - b.lastScore;
    return a.dueAt - b.dueAt;
  });
  return due.slice(0, Math.max(0, limit));
}

/** Reviews due within the next `days` days (including overdue ones), soonest first. */
export function upcomingReviews(states: ReviewState[], now: number, days = 7): ReviewState[] {
  return states.filter((s) => s.dueAt <= now + days * DAY_MS).sort((a, b) => a.dueAt - b.dueAt);
}

/** Plain-words label for a due review. */
export function describeDue(state: ReviewState, now: number): string {
  const od = overdueDays(state, now);
  const when = od < 1 ? 'due today' : od < 2 ? '1 day overdue' : `${Math.floor(od)} days overdue`;
  const m = state.mastery === 'mastered' ? 'keep it fresh' : state.mastery === 'learned' ? 'lock it in' : 'still learning it';
  return `${when}, ${m} (best ${state.bestScore})`;
}

/**
 * Then vs now: the first and the latest recording of a phrase (or of full runs when
 * `phraseIndex` is null). Returns null when there is nothing to compare.
 */
export function firstAndLatest(recordings: RecordingRecord[], phraseIndex: number | null): { first: RecordingRecord; latest: RecordingRecord; count: number } | null {
  const rel = recordings
    .filter((r) => (phraseIndex === null ? r.kind === 'full' : r.kind === 'phrase' && r.phraseIndex === phraseIndex))
    .sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
  if (rel.length === 0) return null;
  return { first: rel[0], latest: rel[rel.length - 1], count: rel.length };
}
