// Pure helpers for the Progress page: technique trends from attempt frames, the streak calendar
// and game bests per song.

import type { GameResult, PhraseAttempt, PitchFrame, SessionRecord, SongRecord } from './types';
import { addDays, dayKey, secondsPerDay, startOfDay } from './habits';
import { bestGame } from './game';

export interface TechniquePoint {
  day: number; // local midnight epoch ms
  breathiness: number | null; // mean over voiced frames, 0..1
  pressed: number | null;
  frames: number; // voiced frames that carried the fields
}

function isVoiced(f: PitchFrame): boolean {
  if (typeof f.voicing === 'number') return f.voicing >= 0.5 && f.hz > 0;
  return f.hz > 0;
}

/** Mean breathiness and pressed over the voiced frames of one attempt (null when the frames lack the fields). */
export function techniqueOfAttempt(frames: PitchFrame[]): { breathiness: number | null; pressed: number | null; n: number } {
  let bSum = 0;
  let bN = 0;
  let pSum = 0;
  let pN = 0;
  for (const f of frames) {
    if (!isVoiced(f)) continue;
    if (typeof f.breathiness === 'number' && isFinite(f.breathiness)) {
      bSum += f.breathiness;
      bN++;
    }
    if (typeof f.pressed === 'number' && isFinite(f.pressed)) {
      pSum += f.pressed;
      pN++;
    }
  }
  return { breathiness: bN ? bSum / bN : null, pressed: pN ? pSum / pN : null, n: Math.max(bN, pN) };
}

/**
 * Per-day technique trend: frame-weighted mean of breathiness and pressed across the attempts of
 * each local day. Days whose attempts carry neither field are left out.
 */
export function techniqueTrend(attempts: PhraseAttempt[]): TechniquePoint[] {
  const byDay = new Map<number, { b: number; bn: number; p: number; pn: number }>();
  for (const a of attempts) {
    const t = techniqueOfAttempt(a.frames ?? []);
    if (t.breathiness === null && t.pressed === null) continue;
    const day = startOfDay(a.date);
    const acc = byDay.get(day) ?? { b: 0, bn: 0, p: 0, pn: 0 };
    if (t.breathiness !== null) {
      acc.b += t.breathiness * t.n;
      acc.bn += t.n;
    }
    if (t.pressed !== null) {
      acc.p += t.pressed * t.n;
      acc.pn += t.n;
    }
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, acc]) => ({
      day,
      breathiness: acc.bn ? acc.b / acc.bn : null,
      pressed: acc.pn ? acc.p / acc.pn : null,
      frames: Math.max(acc.bn, acc.pn),
    }));
}

export interface CalendarCell {
  day: number; // local midnight epoch ms
  key: string; // YYYY-MM-DD
  minutes: number;
  future: boolean;
  today: boolean;
}

/**
 * The last `weeks` weeks as rows of 7 cells (Monday first), ending with the current week.
 * Minutes come from sessions, attributed to the day each session started.
 */
export function streakCalendar(sessions: SessionRecord[], now: number, weeks = 12): CalendarCell[][] {
  const per = secondsPerDay(sessions);
  const today = startOfDay(now);
  const dow = (new Date(today).getDay() + 6) % 7;
  const thisMonday = addDays(today, -dow);
  const first = addDays(thisMonday, -7 * (weeks - 1));
  const rows: CalendarCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const row: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      const day = addDays(first, w * 7 + d);
      const key = dayKey(day);
      row.push({ day, key, minutes: Math.round(((per.get(key) ?? 0) / 60) * 10) / 10, future: day > today, today: day === today });
    }
    rows.push(row);
  }
  return rows;
}

export interface GameBest {
  song: SongRecord;
  best: GameResult;
  plays: number;
}

/** Best game per song (songs never played are left out), highest score first. */
export function gameBests(games: GameResult[], songs: SongRecord[]): GameBest[] {
  const out: GameBest[] = [];
  for (const song of songs) {
    const best = bestGame(games, song.id);
    if (!best) continue;
    out.push({ song, best, plays: games.filter((g) => g.songId === song.id).length });
  }
  return out.sort((a, b) => b.best.score - a.best.score);
}
