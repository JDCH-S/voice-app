import type { Profile, SongAnalysis } from './types';
import { midiToName } from './music/notes';

/**
 * Recommend a transposition (semitones, ≤ 0 preferred) so the song's core range
 * (5th–95th percentile) sits inside the singer's comfortable range.
 * 0 means "learn it in the original key".
 */
export function recommendSemitones(analysis: SongAnalysis, profile: Profile): { semitones: number; reason: string } {
  const last = profile.rangeTests[profile.rangeTests.length - 1];
  if (!last) return { semitones: 0, reason: 'Measure your range to get a key recommendation.' };
  const lo = last.lowMidi + 1;
  const hi = last.highMidi - 1;
  const songLo = analysis.range.p05;
  const songHi = analysis.range.p95;
  // allow octave: men singing songs recorded by women (and vice versa) usually sing an octave away
  const candidates: number[] = [];
  for (let k = 0; k >= -12; k--) candidates.push(k);
  for (let k = 1; k <= 7; k++) candidates.push(k);
  const fits = (k: number) => {
    for (const oct of [0, -12, 12]) {
      if (songLo + k + oct >= lo && songHi + k + oct <= hi) return true;
    }
    return false;
  };
  if (fits(0)) return { semitones: 0, reason: `The original key fits your range (${midiToName(last.lowMidi)}–${midiToName(last.highMidi)}).` };
  for (const k of candidates) {
    if (fits(k)) {
      return {
        semitones: k,
        reason:
          k < 0
            ? `The top notes (${midiToName(Math.round(songHi))}) sit above your comfortable range. ${Math.abs(k)} semitone${Math.abs(k) === 1 ? '' : 's'} lower fits.`
            : `The low notes (${midiToName(Math.round(songLo))}) sit below your range. ${k} semitone${k === 1 ? '' : 's'} higher fits.`,
      };
    }
  }
  // cannot fit: centre the song on the singer's range
  const centreSong = (songLo + songHi) / 2;
  const centreMe = (lo + hi) / 2;
  let k = Math.round(centreMe - centreSong);
  while (k > 6) k -= 12;
  while (k < -12) k += 12;
  return { semitones: k, reason: 'The song spans more than your current range; this key centres it. Practise the extremes with "Reach higher".' };
}

export function songDifficulty(analysis: SongAnalysis): number {
  if (analysis.phrases.length === 0) return 1;
  const avg = analysis.phrases.reduce((a, p) => a + p.difficulty, 0) / analysis.phrases.length;
  return Math.round(avg * 10) / 10;
}
