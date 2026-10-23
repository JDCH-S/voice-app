import fs from 'node:fs';
import path from 'node:path';
import { yinCandidates, harmonicEnergy, highpass } from '../src/lib/analysis/melodyExtract';
import { resampleLinear } from '../src/lib/audio/decode';
const dir = process.argv[2];
const buf = fs.readFileSync(path.join(dir, 'test-song.wav'));
const channels = buf.readUInt16LE(22);
const sr = buf.readUInt32LE(24);
const frames = (buf.length - 44) / (2 * channels);
const mono = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  let s = 0;
  for (let c = 0; c < channels; c++) s += buf.readInt16LE(44 + (i * channels + c) * 2) / 32768;
  mono[i] = s / channels;
}
const m = resampleLinear(mono, sr, 22050);
highpass(m, 22050, 150);
const W = 2048;
const win = new Float32Array(W);
for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (W - 1));
const d = new Float32Array(W / 2 + 2);
for (const t of [2.3, 3.5, 5.9, 10.2]) {
  const off = Math.floor(t * 22050) - W / 2;
  const cands = yinCandidates(m, off, W, 22050, 100, 1000, d);
  console.log(`t=${t}s candidates:`);
  for (const c of cands.slice(0, 8)) {
    const f = 22050 / c.tau;
    const midi = 69 + 12 * Math.log2(f / 440);
    const sal = harmonicEnergy(m, off, W, win, f, 22050, [1, 2, 3, 4, 5, 6]);
    const odd = harmonicEnergy(m, off, W, win, f, 22050, [1, 3, 5]);
    const even = harmonicEnergy(m, off, W, win, f, 22050, [2, 4, 6]);
    console.log(`  f=${f.toFixed(1)}Hz midi=${midi.toFixed(2)} d'=${c.val.toFixed(3)} sal=${sal.toExponential(2)} even/odd=${(even / odd).toFixed(2)}`);
  }
}
