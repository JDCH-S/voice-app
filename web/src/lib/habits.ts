// Practice habits: streaks, today's minutes, the daily goal and the next reminder time.
// All functions take `now` (epoch ms) and work in the browser's local time zone.

import type { Profile, SessionRecord } from './types';

export const DEFAULT_DAILY_GOAL_MINUTES = 10;
/** A day counts towards the streak when at least this much active singing happened in it. */
export const STREAK_MIN_SECONDS = 60;

/** Local-midnight epoch ms of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local calendar key "YYYY-MM-DD" of `ts`. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Local midnight `days` days after the day containing `ts` (DST-safe). */
export function addDays(ts: number, days: number): number {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Active seconds per local day, attributing each session to the day it started
 * (a session that crosses midnight counts for the day it began).
 */
export function secondsPerDay(sessions: SessionRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    if (!s || !isFinite(s.startedAt)) continue;
    const k = dayKey(s.startedAt);
    out.set(k, (out.get(k) ?? 0) + Math.max(0, s.activeSeconds || 0));
  }
  return out;
}

/**
 * Consecutive days of practice ending today or yesterday (so the streak is not lost before
 * today's session happens). A day counts with ≥ 60 s of active singing.
 */
export function streakDays(sessions: SessionRecord[], now: number): number {
  const per = secondsPerDay(sessions);
  const active = (ts: number) => (per.get(dayKey(ts)) ?? 0) >= STREAK_MIN_SECONDS;
  let cursor = startOfDay(now);
  if (!active(cursor)) {
    cursor = addDays(cursor, -1);
    if (!active(cursor)) return 0;
  }
  let streak = 0;
  while (active(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
    if (streak > 10000) break;
  }
  return streak;
}

/** Longest streak ever, in days. */
export function longestStreak(sessions: SessionRecord[]): number {
  const per = secondsPerDay(sessions);
  const days = [...per.entries()].filter(([, sec]) => sec >= STREAK_MIN_SECONDS).map(([k]) => k).sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const k of days) {
    const [y, m, d] = k.split('-').map((x) => parseInt(x, 10));
    const ts = new Date(y, m - 1, d).getTime();
    if (prev !== null && Math.round((ts - prev) / 86400000) === 1) run++;
    else run = 1;
    best = Math.max(best, run);
    prev = ts;
  }
  return best;
}

/** Minutes of active singing today (local day of `now`), rounded to one decimal. */
export function todayMinutes(sessions: SessionRecord[], now: number): number {
  const k = dayKey(now);
  let sec = 0;
  for (const s of sessions) if (dayKey(s.startedAt) === k) sec += Math.max(0, s.activeSeconds || 0);
  return Math.round(sec / 6) / 10;
}

export function dailyGoalMinutes(profile: Pick<Profile, 'dailyGoalMinutes'> | null | undefined): number {
  const v = profile?.dailyGoalMinutes;
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : DEFAULT_DAILY_GOAL_MINUTES;
}

/** 0..1 progress towards today's goal. */
export function goalProgress(sessions: SessionRecord[], profile: Pick<Profile, 'dailyGoalMinutes'> | null | undefined, now: number): number {
  return Math.min(1, todayMinutes(sessions, now) / dailyGoalMinutes(profile));
}

/** Parse "HH:MM" (24 h). Returns null when off or malformed. */
export function parseReminderTime(s: string | null | undefined): { h: number; m: number } | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

/**
 * Next time (epoch ms) the daily reminder should fire: today at the set time if that is still
 * ahead, else tomorrow. Null when no reminder is set.
 */
export function nextReminderAt(profile: Pick<Profile, 'reminderTime'> | null | undefined, now: number): number | null {
  const t = parseReminderTime(profile?.reminderTime);
  if (!t) return null;
  const today = new Date(startOfDay(now));
  today.setHours(t.h, t.m, 0, 0);
  if (today.getTime() > now) return today.getTime();
  const tomorrow = new Date(addDays(now, 1));
  tomorrow.setHours(t.h, t.m, 0, 0);
  return tomorrow.getTime();
}

/** One encouraging line for the home screen. */
export function habitLine(sessions: SessionRecord[], profile: Pick<Profile, 'dailyGoalMinutes'> | null | undefined, now: number): string {
  const streak = streakDays(sessions, now);
  const mins = todayMinutes(sessions, now);
  const goal = dailyGoalMinutes(profile);
  const left = Math.max(0, Math.ceil(goal - mins));
  const streakTxt = streak >= 2 ? `${streak}-day streak. ` : '';
  if (mins >= goal) return `${streakTxt}Today's ${goal} minutes are done. Anything more is a bonus.`;
  if (mins > 0) return `${streakTxt}${Math.round(mins)} of ${goal} minutes today: ${left} more to go.`;
  return streak >= 1 ? `${streakTxt}Keep it alive: ${goal} minutes today.` : `Start a streak: ${goal} minutes today.`;
}
