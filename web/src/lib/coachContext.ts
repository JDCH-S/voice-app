// Compact context for the AI coach: what the coach needs to know about the singer, in well under 10 kB.
// Pure functions; nothing here touches the network or the database.

import type { IssueKind, PhraseAttempt, Profile, SessionRecord, SongRecord } from './types';
import { dominantIssue, weakestCriterion } from './plan';
import { midiToName } from './music/notes';
import { songDifficulty } from './songs';
import { dailyGoalMinutes, streakDays, todayMinutes } from './habits';

export const MAX_CONTEXT_BYTES = 10000;
export const CONTEXT_ATTEMPTS = 30;
const MAX_SONGS = 20;

export interface CoachAttemptSummary {
  song: string;
  phrase: number; // 1-based, as the singer sees it
  overall: number;
  pitch: number;
  timing: number;
  length: number;
  expression: number;
  topIssues: IssueKind[];
  daysAgo: number;
}

export interface CoachContext {
  profile: { name: string; level: Profile['level']; goals: Profile['goals'] };
  range: { low: string; high: string; voiceType: string; accuracyScore: number; daysAgo: number } | null;
  recentAttempts: CoachAttemptSummary[];
  weakest: { criterion: 'pitch' | 'timing' | 'length' | 'expression'; average: number } | null;
  dominantIssues: { kind: IssueKind; count: number }[];
  songs: { title: string; artist: string; difficulty: number; phrases: number; bestAvg: number | null }[];
  habits: { streak: number; todayMinutes: number; goal: number };
  weekStart: number; // epoch ms, Monday 00:00 local
  today: string; // ISO date (local calendar day)
}

/** Monday 00:00 local time of the week containing `now`. */
export function weekStartOf(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDay(now: number): string {
  const d = new Date(now);
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function short(s: string, n = 40): string {
  const t = (s || '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** The 1–2 issue kinds with the most severity in one attempt. */
export function topIssueKinds(attempt: PhraseAttempt, limit = 2): IssueKind[] {
  const totals = new Map<IssueKind, number>();
  for (const i of attempt.issues) totals.set(i.kind, (totals.get(i.kind) ?? 0) + i.severity);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

/** Issue kinds by how many of the recent attempts they appeared in, most frequent first. */
export function dominantIssues(attempts: PhraseAttempt[], limit = 3): { kind: IssueKind; count: number }[] {
  const counts = new Map<IssueKind, number>();
  for (const a of attempts) {
    const seen = new Set<IssueKind>();
    for (const i of a.issues) seen.add(i.kind);
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  // keep the severity-weighted dominant issue first when it exists
  const dom = dominantIssue(attempts);
  if (dom) {
    const i = out.findIndex((x) => x.kind === dom);
    if (i > 0) out.unshift(...out.splice(i, 1));
  }
  return out.slice(0, limit);
}

export function buildCoachContext(
  profile: Profile,
  attempts: PhraseAttempt[],
  songs: SongRecord[],
  sessions: SessionRecord[],
  now: number = Date.now(),
): CoachContext {
  const sorted = [...attempts].sort((a, b) => a.date - b.date);
  const recent = sorted.slice(-CONTEXT_ATTEMPTS);
  const titleOf = new Map(songs.map((s) => [s.id, short(s.title, 30)]));
  const rt = profile.rangeTests[profile.rangeTests.length - 1];
  const weak = weakestCriterion(sorted);
  const bestAvg = (song: SongRecord): number | null => {
    const best = new Map<number, number>();
    for (const a of sorted) if (a.songId === song.id) best.set(a.phraseIndex, Math.max(best.get(a.phraseIndex) ?? 0, a.scores.overall));
    const vals = [...best.values()];
    return vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : null;
  };
  const ctx: CoachContext = {
    profile: { name: short(profile.name, 30), level: profile.level, goals: profile.goals },
    range: rt
      ? {
          low: midiToName(rt.lowMidi),
          high: midiToName(rt.highMidi),
          voiceType: rt.voiceType,
          accuracyScore: Math.round(rt.accuracyScore),
          daysAgo: Math.max(0, Math.floor((now - rt.date) / 86400000)),
        }
      : null,
    recentAttempts: recent.map((a) => ({
      song: titleOf.get(a.songId) ?? 'deleted song',
      phrase: a.phraseIndex + 1,
      overall: Math.round(a.scores.overall),
      pitch: Math.round(a.scores.pitch),
      timing: Math.round(a.scores.timing),
      length: Math.round(a.scores.length),
      expression: Math.round(a.scores.expression),
      topIssues: topIssueKinds(a),
      daysAgo: Math.max(0, Math.floor((now - a.date) / 86400000)),
    })),
    weakest: weak ? { criterion: weak.key, average: Math.round(weak.value) } : null,
    dominantIssues: dominantIssues(recent),
    songs: songs.slice(0, MAX_SONGS).map((s) => ({
      title: short(s.title),
      artist: short(s.artist, 30),
      difficulty: songDifficulty(s.analysis),
      phrases: s.analysis.phrases.length,
      bestAvg: bestAvg(s),
    })),
    habits: { streak: streakDays(sessions, now), todayMinutes: Math.round(todayMinutes(sessions, now)), goal: dailyGoalMinutes(profile) },
    weekStart: weekStartOf(now),
    today: isoDay(now),
  };
  return trimContext(ctx);
}

/** Size of the context as sent over the wire. */
export function contextBytes(ctx: CoachContext): number {
  return new TextEncoder().encode(JSON.stringify(ctx)).length;
}

/** Keep the context under MAX_CONTEXT_BYTES by dropping the oldest attempts, then extra songs. */
export function trimContext(ctx: CoachContext): CoachContext {
  let out = ctx;
  let guard = 0;
  while (contextBytes(out) > MAX_CONTEXT_BYTES && guard++ < 40) {
    if (out.recentAttempts.length > 8) out = { ...out, recentAttempts: out.recentAttempts.slice(-Math.floor(out.recentAttempts.length * 0.7)) };
    else if (out.songs.length > 5) out = { ...out, songs: out.songs.slice(0, Math.floor(out.songs.length * 0.7)) };
    else if (out.recentAttempts.length > 0) out = { ...out, recentAttempts: out.recentAttempts.slice(-Math.max(0, out.recentAttempts.length - 2)) };
    else break;
  }
  return out;
}

/** The text sent as the opening message when the singer comes from a session recap. */
export function recapPrompt(s: SessionRecord): string {
  const r = s.recap;
  const parts = [`I just finished a ${Math.round(s.activeSeconds / 60)}-minute session with ${s.phraseAttemptIds.length} phrase takes and ${s.exerciseResultIds.length} exercise reps.`];
  if (r?.avgScore !== null && r?.avgScore !== undefined) parts.push(`Average score ${r.avgScore}${r.bestScore !== null ? `, best ${r.bestScore}` : ''}.`);
  if (r?.improved.length) parts.push(`Improved: ${r.improved.slice(0, 3).join('; ')}.`);
  if (r?.biggestFix) parts.push(`The app says the one thing to fix is: ${r.biggestFix}`);
  parts.push('What should I focus on next time, and how?');
  return parts.join(' ');
}
