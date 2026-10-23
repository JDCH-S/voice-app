// Tune the fallback melody tracker offline: npx tsx scripts/melodytest.ts <dir with test-song.wav + notes.txt>
import fs from 'node:fs';
import path from 'node:path';
import { extractMelody } from '../src/lib/analysis/melodyExtract';
import { buildAnalysis } from '../src/lib/analysis/segment';
import { resampleLinear } from '../src/lib/audio/decode';
import { midiToName } from '../src/lib/music/notes';

const dir = process.argv[2];
const buf = fs.readFileSync(path.join(dir, 'test-song.wav'));
const channels = buf.readUInt16LE(22);
const sr = buf.readUInt32LE(24);
const dataOff = 44;
const frames = (buf.length - dataOff) / (2 * channels);
const mono = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  let s = 0;
  for (let c = 0; c < channels; c++) s += buf.readInt16LE(dataOff + (i * channels + c) * 2) / 32768;
  mono[i] = s / channels;
}
const truth = fs
  .readFileSync(path.join(dir, 'notes.txt'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => l.split(' '))
  .map(([m, a, b]) => ({ midi: +m, start: +a, end: +b }));
const t0 = performance.now();
const m22 = resampleLinear(mono, sr, 22050);
const r = extractMelody(m22, 22050);
const analysis = buildAnalysis({ t0: r.t0, hop: r.hop, hz: Array.from(r.hz), rmsDb: Array.from(r.rmsDb) }, frames / sr, 'mix');
console.log(`extraction ${(performance.now() - t0).toFixed(0)} ms, ${analysis.notes.length} notes, ${analysis.phrases.length} phrases`);
// frame-level accuracy vs truth
let voicedTrue = 0, hit = 0, octave = 0, falseVoiced = 0;
for (let i = 0; i < r.hz.length; i++) {
  const t = r.t0 + i * r.hop;
  const tn = truth.find((n) => t >= n.start + 0.05 && t < n.end - 0.05);
  const hz = r.hz[i];
  if (tn) {
    voicedTrue++;
    if (hz > 0) {
      const err = Math.abs(69 + 12 * Math.log2(hz / 440) - tn.midi);
      if (err < 0.6) hit++;
      else if (Math.abs(err - 12) < 0.6) octave++;
    }
  } else if (hz > 0) falseVoiced++;
}
console.log(`frames: correct ${((hit / voicedTrue) * 100).toFixed(1)}%  octave-off ${((octave / voicedTrue) * 100).toFixed(1)}%  false-voiced ${falseVoiced}`);
let noteHit = 0;
for (const tn of truth) {
  const mid = (tn.start + tn.end) / 2;
  const d = analysis.notes.find((n) => mid >= n.start && mid <= n.end);
  if (d && Math.abs(d.midi - tn.midi) <= 1) noteHit++;
}
console.log(`notes within ±1 st at their midpoint: ${noteHit}/${truth.length}`);
console.log('detected:', analysis.notes.map((n) => `${midiToName(n.midi)}@${n.start.toFixed(1)}`).join(' '));
console.log('truth:   ', truth.map((n) => `${midiToName(n.midi)}@${n.start.toFixed(1)}`).join(' '));
