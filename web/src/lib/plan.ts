import type { ExerciseResult, PhraseAttempt, Profile, SongRecord, IssueKind, SessionRecap } from './types';
import { EXERCISES, exerciseById, warmupFor } from './exercises/library';
import { tipFor } from './scoring/score';

export interface PlanItem {
  kind: 'warmup' | 'exercise' | 'phrase' | 'song' | 'range-test' | 'import';
  title: string;
  why: string;
  exerciseId?: string;
  songId?: string;
  phraseIndex?: number;
  minutes: number;
}

export const RANGE_RETEST_DAYS = 21;

export function daysSince(ts: number | undefined): number {
  if (!ts) return Infinity;
  return (Date.now() - ts) / 86400000;
}

/** Weakest criterion across recent attempts. */
export function weakestCriterion(attempts: PhraseAttempt[]): { key: 'pitch' | 'timing' | 'length' | 'expression'; value: number } | null {
  const recent = attempts.slice(-25);
  if (recent.length === 0) return null;
  const keys = ['pitch', 'timing', 'length', 'expression'] as const;
  let best: { key: (typeof keys)[number]; value: number } | null = null;
  for (const k of keys) {
    const v = recent.reduce((a, b) => a + b.scores[k], 0) / recent.length;
    if (!best || v < best.value) best = { key: k, value: v };
  }
  return best;
}

export function dominantIssue(attempts: PhraseAttempt[]): IssueKind | null {
  const totals = new Map<IssueKind, number>();
  for (const a of attempts) for (const i of a.issues) totals.set(i.kind, (totals.get(i.kind) ?? 0) + i.severity);
  let best: IssueKind | null = null;
  let bv = 0;
  for (const [k, v] of totals)
    if (v > bv) {
      bv = v;
      best = k;
    }
  return best;
}

export function buildPlan(profile: Profile, attempts: PhraseAttempt[], exResults: ExerciseResult[], songs: SongRecord[]): PlanItem[] {
  const items: PlanItem[] = [];
  const warm = warmupFor(profile.level, profile.goals);
  items.push({
    kind: 'warmup',
    title: `Warm up (${warm.map((w) => w.name.toLowerCase()).join(', ')})`,
    why: 'Always start here. Five minutes protects your voice and makes everything after it easier.',
    minutes: warm.reduce((a, b) => a + b.minutes, 0),
  });
  const last = profile.rangeTests[profile.rangeTests.length - 1];
  if (!last || daysSince(last.date) >= RANGE_RETEST_DAYS) {
    items.push({
      kind: 'range-test',
      title: last ? 'Re-test your range' : 'Measure your range',
      why: last ? `It has been ${Math.floor(daysSince(last.date))} days. Let's see what changed.` : 'We tailor every exercise and key to it.',
      minutes: 4,
    });
  }
  const dom = dominantIssue(attempts.slice(-30));
  if (dom) {
    const tip = tipFor(dom);
    const ex = exerciseById(tip.exerciseId);
    if (ex)
      items.push({
        kind: 'exercise',
        title: ex.name,
        why: `${tip.title}: this was your most frequent issue in recent songs.`,
        exerciseId: ex.id,
        minutes: ex.minutes,
      });
  } else if (profile.goals.includes('range')) {
    items.push({ kind: 'exercise', title: 'Reach higher', why: 'You said range is a goal.', exerciseId: 'range-extension', minutes: 5 });
  } else if (profile.goals.includes('technique')) {
    items.push({ kind: 'exercise', title: 'Chest to head', why: 'You said technique is a goal.', exerciseId: 'register-transitions', minutes: 5 });
  }
  // weakest phrase among songs
  const bestByPhrase = new Map<string, number>();
  for (const a of attempts) {
    const k = `${a.songId}:${a.phraseIndex}`;
    bestByPhrase.set(k, Math.max(bestByPhrase.get(k) ?? 0, a.scores.overall));
  }
  let weakest: { songId: string; phraseIndex: number; score: number } | null = null;
  for (const [k, v] of bestByPhrase) {
    const [songId, pi] = k.split(':');
    if (!songs.find((s) => s.id === songId)) continue;
    if (!weakest || v < weakest.score) weakest = { songId, phraseIndex: parseInt(pi, 10), score: v };
  }
  if (weakest && weakest.score < 85) {
    const song = songs.find((s) => s.id === weakest!.songId)!;
    items.push({
      kind: 'phrase',
      title: `${song.title}: phrase ${weakest.phraseIndex + 1}`,
      why: `Your best so far is ${weakest.score}. Loop it slowly with the guide tone, then without.`,
      songId: song.id,
      phraseIndex: weakest.phraseIndex,
      minutes: 6,
    });
  }
  // a song not yet practised
  const practised = new Set(attempts.map((a) => a.songId));
  const fresh = songs.find((s) => !practised.has(s.id));
  if (fresh) items.push({ kind: 'song', title: `Start "${fresh.title}"`, why: 'You added it but have not sung it yet.', songId: fresh.id, minutes: 10 });
  if (songs.length === 0) items.push({ kind: 'import', title: 'Add a song you love', why: 'Upload an MP3 and we will build the reference vocal line.', minutes: 2 });
  // an exercise not done in a while
  const lastByEx = new Map<string, number>();
  for (const r of exResults) lastByEx.set(r.exerciseId, Math.max(lastByEx.get(r.exerciseId) ?? 0, r.date));
  const stale = EXERCISES.filter((e) => !items.some((i) => i.exerciseId === e.id)).sort((a, b) => (lastByEx.get(a.id) ?? 0) - (lastByEx.get(b.id) ?? 0))[0];
  if (stale && items.length < 5) items.push({ kind: 'exercise', title: stale.name, why: lastByEx.has(stale.id) ? 'Not done in a while.' : 'You have not tried this one yet.', exerciseId: stale.id, minutes: stale.minutes });
  return items;
}

/** Summarise a session: what improved and the one thing to fix next. */
export function buildRecap(sessionAttempts: PhraseAttempt[], previousAttempts: PhraseAttempt[], songs: SongRecord[]): SessionRecap {
  const improved: string[] = [];
  const bestBefore = new Map<string, number>();
  for (const a of previousAttempts) {
    const k = `${a.songId}:${a.phraseIndex}`;
    bestBefore.set(k, Math.max(bestBefore.get(k) ?? 0, a.scores.overall));
  }
  const bestNow = new Map<string, number>();
  for (const a of sessionAttempts) {
    const k = `${a.songId}:${a.phraseIndex}`;
    bestNow.set(k, Math.max(bestNow.get(k) ?? 0, a.scores.overall));
  }
  for (const [k, v] of bestNow) {
    const before = bestBefore.get(k);
    const [songId, pi] = k.split(':');
    const song = songs.find((s) => s.id === songId);
    const name = song ? `${song.title} phrase ${parseInt(pi, 10) + 1}` : `phrase ${parseInt(pi, 10) + 1}`;
    if (before === undefined) {
      if (v >= 70) improved.push(`${name}: first attempts already at ${v}`);
    } else if (v > before + 3) improved.push(`${name}: ${before} → ${v}`);
  }
  const dom = dominantIssue(sessionAttempts);
  const tip = dom ? tipFor(dom) : null;
  const scores = sessionAttempts.map((a) => a.scores.overall);
  return {
    improved: improved.slice(0, 5),
    biggestFix: tip ? `${tip.title}. ${tip.detail}` : 'Nothing stood out. Keep going and add a new phrase next time.',
    exerciseId: tip?.exerciseId ?? null,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    bestScore: scores.length ? Math.max(...scores) : null,
  };
}
