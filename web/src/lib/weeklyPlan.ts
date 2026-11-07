// "Your week": a seven-day practice plan. The coach writes it when available; otherwise the
// rule-based daily plan is spread over the week. Cached per week in the settings store.

import type { SongRecord, WeeklyPlan, WeeklyPlanDay } from './types';
import type { PlanItem } from './plan';
import { exerciseById } from './exercises/library';
import { getSetting, setSetting } from './store/db';
import { weekStartOf } from './coachContext';

export const WEEKLY_PLAN_KEY = 'weeklyPlan';
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
/** Thursday: a mid-week rest keeps the voice fresh for the weekend. */
export const REST_DAY_INDEX = 3;

type DayItem = WeeklyPlanDay['items'][number];
const ITEM_KINDS: DayItem['kind'][] = ['exercise', 'song', 'phrase', 'rest', 'range-test'];

/** Index 0..6 (Monday = 0) of the local day containing `now`. */
export function weekdayIndex(now: number): number {
  return (new Date(now).getDay() + 6) % 7;
}

function planItemToDayItem(item: PlanItem): DayItem | null {
  switch (item.kind) {
    case 'warmup':
      return { kind: 'exercise', title: 'Warm-up', exerciseId: null, minutes: item.minutes };
    case 'exercise':
      return { kind: 'exercise', title: item.title, exerciseId: item.exerciseId ?? null, minutes: item.minutes };
    case 'phrase':
    case 'review':
      return { kind: 'phrase', title: item.title, songId: item.songId ?? null, phraseIndex: item.phraseIndex ?? null, minutes: item.minutes };
    case 'song':
      return { kind: 'song', title: item.title, songId: item.songId ?? null, minutes: item.minutes };
    case 'range-test':
      return { kind: 'range-test', title: item.title, minutes: item.minutes };
    case 'import':
      return null;
  }
}

/**
 * Spread today's rule-based plan over the week: every practice day starts with the warm-up,
 * due reviews land on today, the other items rotate (starting today, so today's slot matches
 * today's plan) with one or two per day, and one day is a rest day.
 */
export function rulesWeeklyPlan(items: PlanItem[], weekStart: number, now: number = Date.now()): WeeklyPlan {
  const warm = items.find((i) => i.kind === 'warmup');
  const warmItem = warm ? planItemToDayItem(warm) : null;
  const reviews = items.filter((i) => i.kind === 'review').map(planItemToDayItem).filter((x): x is DayItem => x !== null);
  const work = items
    .filter((i) => i.kind !== 'warmup' && i.kind !== 'review')
    .map(planItemToDayItem)
    .filter((x): x is DayItem => x !== null);
  const today = weekStartOf(now) === weekStart ? weekdayIndex(now) : 0;
  const reviewDay = today === REST_DAY_INDEX ? (today + 1) % 7 : today;
  const perDay = work.length === 0 ? 0 : work.length <= 2 ? 1 : 2;
  // practice days in rotation order, starting today
  const order: number[] = [];
  for (let k = 0; k < 7; k++) {
    const d = (today + k) % 7;
    if (d !== REST_DAY_INDEX) order.push(d);
  }
  const days: WeeklyPlanDay[] = [];
  for (let d = 0; d < 7; d++) {
    if (d === REST_DAY_INDEX) {
      days.push({ day: DAY_LABELS[d], focus: 'Rest your voice', items: [{ kind: 'rest', title: 'Rest day: water, gentle humming at most', minutes: 0 }] });
      continue;
    }
    const dayItems: DayItem[] = [];
    if (warmItem) dayItems.push(warmItem);
    if (d === reviewDay) dayItems.push(...reviews);
    const slot = order.indexOf(d);
    for (let k = 0; k < perDay && work.length; k++) dayItems.push(work[(slot * perDay + k) % work.length]);
    if (dayItems.length === 0) dayItems.push({ kind: 'exercise', title: 'Pick any exercise', exerciseId: null, minutes: 5 });
    const main = dayItems.find((x) => x !== warmItem) ?? dayItems[0];
    days.push({ day: DAY_LABELS[d], focus: focusFor(main), items: dedupe(dayItems) });
  }
  const total = days.reduce((a, d) => a + d.items.reduce((x, y) => x + y.minutes, 0), 0);
  return {
    weekStart,
    summary: `Built from your results: about ${Math.round(total / 6)} minutes a day with one rest day. The coach can write a more personal plan when the analysis service and a key are set up.`,
    days,
    source: 'rules',
  };
}

function dedupe(items: DayItem[]): DayItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.kind}:${i.exerciseId ?? ''}:${i.songId ?? ''}:${i.phraseIndex ?? ''}:${i.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function focusFor(item: DayItem): string {
  switch (item.kind) {
    case 'exercise':
      return item.title.replace(/^Warm up.*$/, 'Technique');
    case 'phrase':
      return 'A hard phrase';
    case 'song':
      return 'A new song';
    case 'range-test':
      return 'Measure your range';
    case 'rest':
      return 'Rest your voice';
  }
}

/**
 * Make a plan from the coach safe to render: seven days in order, known kinds, ids that exist,
 * sane minutes. Returns null when the shape is unusable.
 */
export function normalizeWeeklyPlan(raw: unknown, weekStart: number, songs: SongRecord[]): WeeklyPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WeeklyPlan>;
  if (!Array.isArray(r.days) || r.days.length === 0) return null;
  const songIds = new Set(songs.map((s) => s.id));
  const byLabel = new Map<string, WeeklyPlanDay>();
  for (const d of r.days as Partial<WeeklyPlanDay>[]) {
    if (!d || typeof d !== 'object') continue;
    const label = DAY_LABELS.find((l) => typeof d.day === 'string' && d.day.toLowerCase().startsWith(l.toLowerCase()));
    if (!label || byLabel.has(label)) continue;
    const items: DayItem[] = [];
    for (const it of Array.isArray(d.items) ? (d.items as Partial<DayItem>[]) : []) {
      if (!it || typeof it !== 'object' || !ITEM_KINDS.includes(it.kind as DayItem['kind'])) continue;
      const title = typeof it.title === 'string' && it.title.trim() ? it.title.trim().slice(0, 120) : null;
      if (!title) continue;
      const minutes = typeof it.minutes === 'number' && isFinite(it.minutes) ? Math.max(0, Math.min(60, Math.round(it.minutes))) : 5;
      const exerciseId = typeof it.exerciseId === 'string' && exerciseById(it.exerciseId) ? it.exerciseId : null;
      const songId = typeof it.songId === 'string' && songIds.has(it.songId) ? it.songId : null;
      const song = songId ? songs.find((s) => s.id === songId) : null;
      const phraseIndex =
        song && typeof it.phraseIndex === 'number' && Number.isInteger(it.phraseIndex) && it.phraseIndex >= 0 && it.phraseIndex < song.analysis.phrases.length
          ? it.phraseIndex
          : null;
      items.push({ kind: it.kind as DayItem['kind'], title, exerciseId, songId, phraseIndex, minutes });
    }
    if (items.length === 0) items.push({ kind: 'rest', title: 'Rest', minutes: 0 });
    byLabel.set(label, { day: label, focus: typeof d.focus === 'string' ? d.focus.trim().slice(0, 80) : '', items: items.slice(0, 6) });
  }
  if (byLabel.size === 0) return null;
  const days = DAY_LABELS.map((l) => byLabel.get(l) ?? { day: l, focus: 'Rest your voice', items: [{ kind: 'rest' as const, title: 'Rest day', minutes: 0 }] });
  return {
    weekStart,
    summary: typeof r.summary === 'string' ? r.summary.trim().slice(0, 400) : 'Your plan for this week.',
    days,
    source: r.source === 'rules' ? 'rules' : 'coach',
  };
}

/** The cached plan for the current week, or null when none or stale. */
export async function loadCachedWeeklyPlan(now: number = Date.now()): Promise<WeeklyPlan | null> {
  const cached = await getSetting<WeeklyPlan | null>(WEEKLY_PLAN_KEY, null);
  if (!cached || typeof cached !== 'object' || cached.weekStart !== weekStartOf(now) || !Array.isArray(cached.days)) return null;
  return cached;
}

export async function cacheWeeklyPlan(plan: WeeklyPlan): Promise<void> {
  await setSetting(WEEKLY_PLAN_KEY, plan);
}
