// Adaptive difficulty: recommends tempo / guide / loop for the next attempt at a phrase from the
// singer's recent scores. Pure, deterministic.

import type { AdaptiveSettings, Level, Mastery, PhraseAttempt } from './types';

/** Tempo steps the player offers, fastest first. */
export const TEMPO_STEPS = [1, 0.85, 0.7, 0.5] as const;
export const SLOWEST_TEMPO = 0.5;

/** What a phrase starts at for a given level. */
export function defaultSettings(level: Level): AdaptiveSettings {
  switch (level) {
    case 'advanced':
      return { tempo: 1, guide: false, loop: false, reason: 'Full speed, no guide tone: show me what you have got.' };
    case 'intermediate':
      return { tempo: 1, guide: true, loop: false, reason: 'Full speed with the guide tone to start.' };
    default:
      return { tempo: 0.85, guide: true, loop: true, reason: 'A little slower with the guide tone on, looping so you can settle in.' };
  }
}

/** Nearest offered tempo step to `t`. */
export function nearestStep(t: number): number {
  let best: number = TEMPO_STEPS[0];
  for (const s of TEMPO_STEPS) if (Math.abs(s - t) < Math.abs(best - t)) best = s;
  return best;
}

function slower(t: number): number {
  const i = TEMPO_STEPS.indexOf(nearestStep(t) as (typeof TEMPO_STEPS)[number]);
  return TEMPO_STEPS[Math.min(TEMPO_STEPS.length - 1, i + 1)];
}

function faster(t: number): number {
  const i = TEMPO_STEPS.indexOf(nearestStep(t) as (typeof TEMPO_STEPS)[number]);
  return TEMPO_STEPS[Math.max(0, i - 1)];
}

function pct(t: number): string {
  return `${Math.round(t * 100)}%`;
}

/**
 * Decide the settings for the next attempt.
 * `attempts`: every attempt at this phrase, oldest first (only the recent ones matter).
 * `current`: the settings of the attempt that was just made (tempo must match the attempts' tempo
 * for the "at the current settings" rules to apply).
 *
 * Rules: two scores < 60 at the current tempo → slow one step and turn the guide on (never below 50 %);
 * two scores ≥ 85 at the current tempo → speed up one step, and once at full speed turn the guide off.
 */
export function nextSettings(attempts: PhraseAttempt[], current: AdaptiveSettings, level: Level): AdaptiveSettings {
  const tempo = nearestStep(current.tempo);
  const atCurrent = attempts.filter((a) => Math.abs(nearestStep(a.tempo) - tempo) < 1e-6);
  const lastTwo = atCurrent.slice(-2);
  const keep = (reason: string): AdaptiveSettings => ({ tempo, guide: current.guide, loop: current.loop, reason });

  if (lastTwo.length < 2) {
    const last = attempts[attempts.length - 1];
    if (!last) return { ...defaultSettings(level), tempo, guide: current.guide, loop: current.loop, reason: 'First try. Sing it once and we will adjust from there.' };
    if (last.scores.overall < 60) return keep(`Scored ${last.scores.overall}. One more go at ${pct(tempo)} before we change anything.`);
    if (last.scores.overall >= 85) return keep(`Scored ${last.scores.overall}. Do that once more and we will speed up.`);
    return keep(`Scored ${last.scores.overall}. Keep going at ${pct(tempo)}.`);
  }

  const [a, b] = lastTwo.map((x) => x.scores.overall);
  const struggling = a < 60 && b < 60;
  const nailing = a >= 85 && b >= 85;

  if (struggling) {
    if (tempo > SLOWEST_TEMPO) {
      const t = slower(tempo);
      const guideTxt = current.guide ? '' : ' and turned the guide on';
      return { tempo: t, guide: true, loop: true, reason: `Slowed to ${pct(t)}${guideTxt}. You'll get it: listen first, then sing with the guide.` };
    }
    if (!current.guide) return { tempo, guide: true, loop: true, reason: 'Turned the guide tone on at 50%. Hum along with it before you sing the words.' };
    return { tempo, guide: true, loop: true, reason: 'Already at 50% with the guide. Play "Listen" a few times and hum the line, then sing just the first two notes.' };
  }

  if (nailing) {
    if (tempo < 1) {
      const t = faster(tempo);
      return { tempo: t, guide: current.guide, loop: current.loop, reason: `Two strong takes (${a}, ${b}). Sped up to ${pct(t)}.` };
    }
    if (current.guide) return { tempo: 1, guide: false, loop: current.loop, reason: `Two strong takes at full speed (${a}, ${b}). Guide tone off: it is yours now.` };
    return { tempo: 1, guide: false, loop: false, reason: `Mastered at full speed (${a}, ${b}). Move on to the next phrase or run the song.` };
  }

  // middle ground: a recovering singer at a slow tempo with the guide gets encouragement, nothing changes
  const avg = Math.round((a + b) / 2);
  if (level === 'advanced' && tempo < 1 && avg >= 75) return { tempo: faster(tempo), guide: current.guide, loop: current.loop, reason: `Averaging ${avg}. Back up to ${pct(faster(tempo))}: you can take it.` };
  return keep(`Averaging ${avg} at ${pct(tempo)}. One more take, then we adjust.`);
}

/** Mastery of a phrase from its scores, oldest first. */
export function masteryFor(scores: number[]): Mastery {
  if (scores.length === 0) return 'new';
  const last3 = scores.slice(-3);
  const last2 = scores.slice(-2);
  if (last3.length === 3 && last3.every((s) => s >= 90)) return 'mastered';
  if (last2.length === 2 && last2.every((s) => s >= 85) && Math.max(...scores) >= 90) return 'mastered';
  if (last2.length === 2 && last2.every((s) => s >= 75)) return 'learned';
  if (scores.length === 1 && scores[0] >= 90) return 'learned';
  return 'learning';
}
