export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi: number): string {
  const m = Math.round(midi);
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

export function nameToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`Bad note name ${name}`);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semis = base[m[1].toUpperCase()];
  if (m[2] === '#') semis += 1;
  if (m[2] === 'b') semis -= 1;
  return (parseInt(m[3], 10) + 1) * 12 + semis;
}

export function centsBetween(hzA: number, hzB: number): number {
  return 1200 * Math.log2(hzA / hzB);
}

/** Signed cents of `midi` (float) from the nearest semitone of `target`. */
export function centsFromTarget(midi: number, target: number): number {
  return (midi - target) * 100;
}

export function fold(x: number, m: number): number {
  return ((x % m) + m) % m;
}

export function keyName(tonic: string, mode: 'major' | 'minor'): string {
  return `${tonic} ${mode}`;
}

export function transposeKey(tonic: string, semis: number): string {
  const idx = NOTE_NAMES.indexOf(tonic);
  if (idx < 0) return tonic;
  return NOTE_NAMES[fold(idx + semis, 12)];
}

export const VOICE_TYPES: { name: string; low: string; high: string }[] = [
  { name: 'Bass', low: 'E2', high: 'E4' },
  { name: 'Baritone', low: 'G2', high: 'G4' },
  { name: 'Tenor', low: 'C3', high: 'C5' },
  { name: 'Alto', low: 'F3', high: 'F5' },
  { name: 'Mezzo-soprano', low: 'A3', high: 'A5' },
  { name: 'Soprano', low: 'C4', high: 'C6' },
];

/** Closest classical voice type by overlap with the measured comfortable range. */
export function voiceTypeFor(lowMidi: number, highMidi: number): string {
  let best = VOICE_TYPES[0].name;
  let bestScore = -Infinity;
  for (const vt of VOICE_TYPES) {
    const lo = nameToMidi(vt.low);
    const hi = nameToMidi(vt.high);
    const overlap = Math.max(0, Math.min(hi, highMidi) - Math.max(lo, lowMidi));
    const centreDist = Math.abs((lo + hi) / 2 - (lowMidi + highMidi) / 2);
    const score = overlap - centreDist * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = vt.name;
    }
  }
  return best;
}

export function formatCents(c: number): string {
  const r = Math.round(c);
  return r > 0 ? `+${r}¢` : `${r}¢`;
}

export function fmtTime(s: number): string {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[idx];
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
