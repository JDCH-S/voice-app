// Logic self-test: run with `npx tsx scripts/selftest.ts`
import { buildAnalysis } from '../src/lib/analysis/segment';
import { scorePhrase } from '../src/lib/scoring/score';
import { alignLyrics, parseLyrics } from '../src/lib/analysis/lyrics';
import { midiToHz, midiToName, median } from '../src/lib/music/notes';
import type { PitchFrame } from '../src/lib/types';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PitchTracker, betaCdfTable, scoreCandidates, voicedProbability, type Dip } from '../src/lib/audio/pitchTrack';
import {
  bandPowersDb,
  breathinessIndex,
  hnrFromAperiodicity,
  pressedIndex,
  spectralCentroid,
  tiltFromBands,
  voiceQualityFor,
} from '../src/lib/audio/voiceQuality';
import { latencyFromOnsets } from '../src/lib/audio/MicAnalyzer';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}

// ---- synthesize a reference melody track (frame-wise f0) ----
const hop = 256 / 22050;
interface Spec { midi: number; start: number; end: number; slideFrom?: number; vibrato?: boolean; db?: number }
const specs: Spec[] = [
  // phrase 1
  { midi: 60, start: 0.5, end: 1.0, db: -12 },
  { midi: 62, start: 1.0, end: 1.5, db: -12 },
  { midi: 64, start: 1.5, end: 2.6, vibrato: true, db: -6 },
  // breath gap 0.4 s, phrase 2 with a slide into the high note
  { midi: 65, start: 3.0, end: 3.4, db: -10 },
  { midi: 67, start: 3.4, end: 3.8, db: -10 },
  { midi: 72, start: 3.8, end: 5.0, slideFrom: 67, vibrato: true, db: -2 },
  // phrase 3: run
  { midi: 71, start: 5.6, end: 5.72 },
  { midi: 69, start: 5.72, end: 5.84 },
  { midi: 67, start: 5.84, end: 5.96 },
  { midi: 65, start: 5.96, end: 6.08 },
  { midi: 64, start: 6.08, end: 7.0, db: -8 },
];
const duration = 8;
const n = Math.ceil(duration / hop);
const hz = new Array<number>(n).fill(0);
const rmsDb = new Array<number>(n).fill(-100);
for (const s of specs) {
  const a = Math.floor(s.start / hop);
  const b = Math.floor(s.end / hop);
  for (let k = a; k < b; k++) {
    const t = k * hop;
    let m = s.midi;
    if (s.slideFrom !== undefined && t < s.start + 0.15) m = s.slideFrom + (s.midi - s.slideFrom) * ((t - s.start) / 0.15);
    if (s.vibrato && t > s.start + 0.3) m += 0.3 * Math.sin(2 * Math.PI * 5.5 * t); // ±30 cents at 5.5 Hz
    hz[k] = midiToHz(m) * (1 + (Math.random() - 0.5) * 0.002);
    rmsDb[k] = (s.db ?? -10) + (Math.random() - 0.5);
  }
}
const analysis = buildAnalysis({ t0: 0, hop, hz, rmsDb }, duration, 'separated');
console.log(`notes: ${analysis.notes.length}, phrases: ${analysis.phrases.length}, breaths at ${analysis.breaths.map((b) => b.toFixed(2)).join(', ')}`);
for (const nt of analysis.notes) {
  console.log(
    `  ${nt.id.toString().padStart(2)} ${midiToName(nt.midi).padEnd(4)} ${nt.start.toFixed(2)}-${nt.end.toFixed(2)} ${nt.dynamic.padEnd(2)} ${nt.loudnessDb.toFixed(1).padStart(6)}dB` +
      `${nt.slideIn ? ` slide from ${midiToName(nt.slideIn.fromMidi)} ${nt.slideIn.duration}s` : ''}${nt.vibrato ? ` vib ${nt.vibrato.rate}Hz ±${nt.vibrato.extentCents}c` : ''}${nt.run ? ' run' : ''}${nt.breathBefore ? ' breath' : ''} ph${nt.phrase}`,
  );
}
check(analysis.notes.length >= 10 && analysis.notes.length <= 12, `segmented ${analysis.notes.length} notes (expected 11)`);
check(analysis.phrases.length === 3, `phrases = ${analysis.phrases.length} (expected 3)`);
const high = analysis.notes.find((x) => x.midi === 72);
check(!!high?.slideIn, 'slide into C5 detected');
check(!!high?.vibrato, 'vibrato on C5 detected');
check(analysis.notes.filter((x) => x.run).length >= 3, 'run detected');
check(analysis.notes.filter((x) => x.breathBefore).length >= 2, 'breath points before phrases 2 and 3');
check(high?.dynamic === 'ff', `C5 is loudest (${high?.dynamic})`);
check(analysis.phrases[1].tags.includes('high-note') && analysis.phrases[1].tags.includes('slide'), `phrase 2 tags: ${analysis.phrases[1].tags.join(',')}`);

// ---- lyrics alignment ----
const ly = parseLyrics('[00:00.40] hello my friend\n[00:02.90] reaching the top note\n[00:05.50] la la la la down', 'lrclib');
alignLyrics(analysis, ly);
check(analysis.phrases[0].text.includes('hello'), `phrase 1 text: "${analysis.phrases[0].text}"`);
check(analysis.phrases[1].text.includes('top'), `phrase 2 text: "${analysis.phrases[1].text}"`);

// ---- simulated singers ----
function sing(opts: { cents?: number; late?: number; shortRatio?: number; skipNote?: number; noSlide?: boolean; octave?: number; frameDt?: number }): PitchFrame[] {
  const dt = opts.frameDt ?? 0.0107;
  const frames: PitchFrame[] = [];
  for (let t = 0; t < duration; t += dt) {
    const note = specs.find((s) => t >= s.start + (opts.late ?? 0) && t < s.start + (opts.late ?? 0) + (s.end - s.start) * (opts.shortRatio ?? 1));
    const idx = note ? specs.indexOf(note) : -1;
    if (!note || idx === opts.skipNote) {
      frames.push({ t, hz: 0, midi: NaN, rms: 0.001, db: -60, clarity: 0 });
      continue;
    }
    let m = note.midi + (opts.cents ?? 0) / 100 + (opts.octave ?? 0) * 12;
    if (note.slideFrom !== undefined && !opts.noSlide && t < note.start + (opts.late ?? 0) + 0.15) m = note.slideFrom + (note.midi - note.slideFrom) * ((t - note.start - (opts.late ?? 0)) / 0.15);
    if (note.vibrato && t > note.start + 0.3) m += 0.3 * Math.sin(2 * Math.PI * 5.5 * t);
    const h = midiToHz(m) * (1 + (Math.random() - 0.5) * 0.003);
    frames.push({ t, hz: h, midi: 69 + 12 * Math.log2(h / 440), rms: 0.1, db: (note.db ?? -10) - 5, clarity: 0.95 });
  }
  return frames;
}
const ph2 = analysis.phrases[1];
const base = { semitones: 0, level: 'intermediate' as const, allowOctave: true };

const perfect = scorePhrase(analysis, ph2, sing({}), base);
console.log('perfect:', JSON.stringify(perfect.scores), perfect.tip.title, perfect.issues.map((i) => i.kind).join(','));
check(perfect.scores.overall >= 90, `perfect singer scores ${perfect.scores.overall}`);

const flat = scorePhrase(analysis, ph2, sing({ cents: -60 }), base);
console.log('flat -60c:', JSON.stringify(flat.scores), flat.tip.title);
check(flat.issues.some((i) => i.kind === 'flat') && flat.tip.title.includes('under'), `flat singer flagged flat (pitch ${flat.scores.pitch})`);

const late = scorePhrase(analysis, ph2, sing({ late: 0.3 }), base);
console.log('late 300ms:', JSON.stringify(late.scores), late.tip.title);
check(late.issues.some((i) => i.kind === 'late') && late.scores.timing < 70, `late singer flagged late (timing ${late.scores.timing})`);

const short = scorePhrase(analysis, ph2, sing({ shortRatio: 0.5 }), base);
console.log('short 50%:', JSON.stringify(short.scores), short.tip.title);
check(short.issues.some((i) => i.kind === 'short'), `short notes flagged (length ${short.scores.length})`);

const noslide = scorePhrase(analysis, ph2, sing({ noSlide: true }), base);
console.log('no slide:', JSON.stringify(noslide.scores), noslide.issues.map((i) => i.kind).join(','));
check(noslide.issues.some((i) => i.kind === 'no-slide'), 'missed slide flagged');

const skipped = scorePhrase(analysis, ph2, sing({ skipNote: 5 }), base);
console.log('skipped C5:', JSON.stringify(skipped.scores), skipped.issues[0]?.text);
check(skipped.issues.some((i) => i.kind === 'missed' && i.noteId === high!.id), 'missed high note flagged');

const oct = scorePhrase(analysis, ph2, sing({ octave: -1 }), base);
console.log('octave down:', JSON.stringify(oct.scores), oct.issues.map((i) => i.kind).join(','));
check(oct.scores.pitch >= 80 && oct.issues.some((i) => i.kind === 'octave'), 'octave-down accepted with a note');

const octStrict = scorePhrase(analysis, ph2, sing({ octave: -1 }), { ...base, allowOctave: false });
check(octStrict.scores.pitch < 40, `octave-down rejected when not allowed (pitch ${octStrict.scores.pitch})`);

const transposed = scorePhrase(analysis, ph2, sing({}).map((f) => ({ ...f, hz: f.hz ? f.hz * Math.pow(2, -3 / 12) : 0, midi: f.midi - 3 })), { ...base, semitones: -3 });
check(transposed.scores.overall >= 90, `transposed -3 singer scores ${transposed.scores.overall}`);


// =====================================================================================
// Audio core: voice-quality formulas, pYIN candidates + Viterbi, and the real worklet file
// =====================================================================================
console.log('\n--- voice quality formulas ---');
check(hnrFromAperiodicity(0.01) > hnrFromAperiodicity(0.2) && hnrFromAperiodicity(0.2) > hnrFromAperiodicity(0.5), 'hnr falls as aperiodicity rises');
check(Math.abs(hnrFromAperiodicity(0.5)) < 1e-9, `hnr(d'=0.5) = 0 dB (${hnrFromAperiodicity(0.5)})`);
check(hnrFromAperiodicity(0) === 40 && hnrFromAperiodicity(1) === -10 && hnrFromAperiodicity(NaN) === -10, 'hnr clamps to −10..40 dB and survives NaN');
check(Math.abs(tiltFromBands([0, 0, 0, 0, 0, 0])) < 1e-9, 'flat bands → tilt 0 dB/oct');
check(Math.abs(tiltFromBands([-10, -16, -22, -28, -34, -40]) + 6) < 1e-9, 'bands falling 6 dB per octave → tilt −6');
check(Math.abs(tiltFromBands([-60, -16, -22, -28, -34, -40], 250) + 6) < 1e-9, 'band entirely below f0 is ignored (250 Hz skips 100-200)');
check(tiltFromBands([-200, -200, -200, -200, -200, -200]) === -12, 'no usable bands → neutral −12');
check(breathinessIndex(30, -8) < 0.05 && breathinessIndex(6, -18) > 0.7 && breathinessIndex(30, -8) < breathinessIndex(12, -12), 'breathiness: clear ≈ 0, airy ≈ 1, monotone in HNR');
{
  const soft = pressedIndex({ tilt: -12, db: -30, midi: 60, hnr: 25 }, { highMidi: 72, referenceDb: -25 });
  const bright = pressedIndex({ tilt: -4, db: -30, midi: 60, hnr: 25 }, { highMidi: 72, referenceDb: -25 });
  const brightLoud = pressedIndex({ tilt: -4, db: -15, midi: 60, hnr: 25 }, { highMidi: 72, referenceDb: -25 });
  const brightLoudHigh = pressedIndex({ tilt: -4, db: -15, midi: 72, hnr: 25 }, { highMidi: 72, referenceDb: -25 });
  const noise = pressedIndex({ tilt: 0, db: -15, midi: 72, hnr: 0 }, { highMidi: 72, referenceDb: -25 });
  check(soft === 0 && bright > 0.3 && brightLoud > bright && brightLoudHigh > brightLoud && brightLoudHigh >= 0.99, `pressed ordering soft ${soft} < bright ${bright.toFixed(2)} < +loud ${brightLoud.toFixed(2)} < +high ${brightLoudHigh.toFixed(2)}`);
  check(noise === 0, 'noise (hnr 0) is never "pressed"');
  const def = pressedIndex({ tilt: -4, db: -15, midi: 74, hnr: 25 });
  check(def > 0.9, `defaults apply when range/level are unknown (${def.toFixed(2)})`);
}
{
  // synthetic power spectra: sawtooth harmonics (power 1/h²) at 220 Hz on a 23.4 Hz grid, and white noise
  const binHz = 48000 / 2048;
  const sawP = new Float64Array(1025);
  for (let h = 1; h * 220 < 12000; h++) sawP[Math.round((h * 220) / binHz)] += 1 / (h * h);
  const flatP = new Float64Array(1025).fill(1);
  const sawTilt = tiltFromBands(bandPowersDb(sawP, binHz), 220);
  const flatTilt = tiltFromBands(bandPowersDb(flatP, binHz));
  check(Math.abs(sawTilt + 6) < 1.5, `sawtooth spectrum tilt ≈ −6 dB/oct (${sawTilt.toFixed(1)})`);
  check(Math.abs(flatTilt) < 0.3, `white spectrum tilt ≈ 0 (${flatTilt.toFixed(2)})`);
  const cSaw = spectralCentroid(sawP, binHz);
  const cFlat = spectralCentroid(flatP, binHz);
  check(cSaw > 300 && cSaw < 700 && cFlat > 3500 && cFlat < 4500, `centroids: sawtooth ${cSaw.toFixed(0)} Hz, white ${cFlat.toFixed(0)} Hz`);
}

console.log('\n--- pYIN candidates and Viterbi (pure) ---');
{
  const cdf = betaCdfTable(2, 8);
  check(voicedProbability(0.05) > 0.95 && Math.abs(voicedProbability(0.35) - 0.5) < 1e-9 && voicedProbability(0.6) < 0.05, 'voiced probability curve');
  const one = scoreCandidates([{ hz: 440, d: 0.02 }], cdf);
  check(one.candidates.length === 1 && Math.abs(one.candidates[0].p + one.unvoiced - 1) < 1e-9 && one.unvoiced < 0.03, `single deep dip: p=${one.candidates[0].p.toFixed(3)} unvoiced=${one.unvoiced.toFixed(3)}`);
  const two = scoreCandidates([{ hz: 880, d: 0.3 }, { hz: 440, d: 0.02 }], cdf);
  const c440 = two.candidates.find((c) => c.hz === 440)!;
  const c880 = two.candidates.find((c) => c.hz === 880)!;
  check(c440.p > 3 * c880.p, `shallow first dip (octave up) loses to the deep dip: 440→${c440.p.toFixed(3)} vs 880→${c880.p.toFixed(3)}`);
  const first = scoreCandidates([{ hz: 880, d: 0.05 }, { hz: 440, d: 0.04 }], cdf);
  const f880 = first.candidates.find((c) => c.hz === 880)!;
  const f440 = first.candidates.find((c) => c.hz === 440)!;
  check(f880.p > f440.p, `two deep dips: the first (shortest period) wins like YIN: 880→${f880.p.toFixed(3)} vs 440→${f440.p.toFixed(3)}`);
  check(scoreCandidates([], cdf).unvoiced === 1, 'no dips → unvoiced 1');

  // Viterbi: steady 220 Hz with octave dips present; one frame where the octave dip is deeper
  const steady = (): Dip[] => [{ hz: 440, d: 0.25 }, { hz: 220, d: 0.04 }, { hz: 110, d: 0.05 }];
  const glitch = (): Dip[] => [{ hz: 440, d: 0.03 }, { hz: 220, d: 0.2 }, { hz: 110, d: 0.21 }];
  const tr = new PitchTracker({ lookahead: 3 });
  const out: { hz: number; voicing: number; t: number }[] = [];
  const naive: number[] = [];
  let returnedEarly = 0;
  for (let k = 0; k < 40; k++) {
    const dips = k === 20 ? glitch() : steady();
    naive.push(dips.find((d) => d.d < 0.15)?.hz ?? 0);
    const r = tr.push({ tCtx: k * 0.01, silent: false, dips });
    if (k < 3 && r) returnedEarly++;
    if (r) out.push({ hz: r.hz, voicing: r.voicing, t: r.input.tCtx });
  }
  const rest = tr.flush();
  check(returnedEarly === 0 && out.length === 37 && rest.length === 3, `lookahead 3: ${out.length} frames emitted during, ${rest.length} on flush`);
  check(out.every((o, i) => Math.abs(o.t - i * 0.01) < 1e-9), 'emitted frames carry their own timestamps in order');
  check(naive.filter((h) => h === 440).length === 1 && out.every((o) => o.hz === 220), 'single-frame octave glitch removed by the smoother (naive YIN flips once)');
  check(out.every((o) => o.voicing > 0.9), `voicing stays high on steady pitch (min ${Math.min(...out.map((o) => o.voicing)).toFixed(2)})`);

  // a real octave leap is followed within the lookahead
  const tr2 = new PitchTracker({ lookahead: 3 });
  const seq: number[] = [];
  for (let k = 0; k < 30; k++) {
    const dips: Dip[] = k < 15 ? [{ hz: 220, d: 0.03 }] : [{ hz: 440, d: 0.03 }];
    const r = tr2.push({ tCtx: k * 0.01, silent: false, dips });
    if (r) seq.push(r.hz);
  }
  seq.push(...tr2.flush().map((r) => r.hz));
  const firstHigh = seq.findIndex((h) => h === 440);
  check(firstHigh >= 15 && firstHigh <= 18 && seq.slice(firstHigh).every((h) => h === 440), `octave leap followed after ${firstHigh - 15} frames`);

  // voiced → silence → voiced
  const tr3 = new PitchTracker({ lookahead: 3 });
  const vs: { hz: number; voicing: number }[] = [];
  for (let k = 0; k < 30; k++) {
    const silent = k >= 10 && k < 20;
    const r = tr3.push({ tCtx: k * 0.01, silent, dips: silent ? [] : [{ hz: 300, d: 0.05 }] });
    if (r) vs.push({ hz: r.hz, voicing: r.voicing });
  }
  vs.push(...tr3.flush().map((r) => ({ hz: r.hz, voicing: r.voicing })));
  check(vs.slice(10, 20).every((v) => v.hz === 0 && v.voicing < 0.05) && vs.slice(0, 10).every((v) => v.hz === 300) && vs.slice(20).every((v) => v.hz === 300), 'silence gap: unvoiced with voicing ≈ 0, voiced again after');

  // weak but consistent evidence (d' ≈ 0.3, breathy) is kept voiced; random noise dips are not
  const tr4 = new PitchTracker({ lookahead: 3 });
  const weak: number[] = [];
  for (let k = 0; k < 30; k++) {
    const r = tr4.push({ tCtx: k * 0.01, silent: false, dips: [{ hz: 250 + (k % 3), d: 0.3 }] });
    if (r) weak.push(r.hz);
  }
  check(weak.slice(3).every((h) => h > 0), `steady breathy pitch (d'=0.3) stays voiced (${weak.filter((h) => h > 0).length}/${weak.length})`);
  const tr5 = new PitchTracker({ lookahead: 3 });
  let rnd = 7;
  const next = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const noisy: number[] = [];
  for (let k = 0; k < 60; k++) {
    const dips: Dip[] = [{ hz: 80 + next() * 1000, d: 0.3 + next() * 0.3 }];
    dips.push({ hz: dips[0].hz / 2, d: 0.4 + next() * 0.4 });
    const r = tr5.push({ tCtx: k * 0.01, silent: false, dips });
    if (r) noisy.push(r.hz);
  }
  check(noisy.filter((h) => h > 0).length <= 3, `random noise dips stay unvoiced (${noisy.filter((h) => h > 0).length}/${noisy.length} voiced)`);
}

console.log('\n--- latency from click onsets ---');
{
  const clicks = [1.0, 1.7, 2.4, 3.1];
  const good = latencyFromOnsets(clicks, [0.4, 1.085, 1.7 + 0.083, 2.4 + 0.086, 3.1 + 0.084, 3.3], 60);
  check(good.measured && good.latencyMs === 85 && good.detected === 4, `four clicks → ${good.latencyMs} ms measured`);
  const three = latencyFromOnsets(clicks, [1.09, 2.49, 3.19], 60);
  check(three.measured && three.latencyMs === 90 && three.detected === 3, `three of four clicks still measured (${three.latencyMs} ms)`);
  const two = latencyFromOnsets(clicks, [1.09, 2.49], 60);
  check(!two.measured && two.latencyMs === 60 && /2 of 4/.test(two.message), `two clicks → fallback: "${two.message}"`);
  const none = latencyFromOnsets(clicks, [], 60);
  check(!none.measured && /headphones/.test(none.message), `no clicks → fallback mentions headphones`);
  const spread = latencyFromOnsets(clicks, [1.02, 1.95, 2.45, 3.4], 60);
  check(!spread.measured && /inconsistent/.test(spread.message), `inconsistent onsets → fallback: "${spread.message}"`);
}

// ---- drive the real worklet file in Node ----
console.log('\n--- pitch worklet (public/pitch-worklet.js) end to end ---');
const SR = 48000;
const HOP = 512;
const WIN = 2048;
interface WorkletMsg { t: number; rms: number; peak: number; silent: boolean; dmin?: number; hz?: number[]; d?: number[]; bands?: number[]; centroid?: number; onset?: number }
type WorkletProc = { process: (inputs: Float32Array[][]) => boolean; port: { onmessage: ((e: { data: unknown }) => void) | null }; spectrum: (f: Float32Array) => { bands: number[]; centroid: number } };
function loadWorklet(): { make: (opts?: Record<string, unknown>) => WorkletProc; env: { currentTime: number; sink: (m: WorkletMsg) => void } } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'public', 'pitch-worklet.js'), 'utf8');
  const env = { currentTime: 0, sink: (_m: WorkletMsg) => {}, registered: null as unknown };
  class AudioWorkletProcessor {
    port: { onmessage: null | ((e: { data: unknown }) => void); postMessage: (m: WorkletMsg) => void };
    constructor() {
      this.port = { onmessage: null, postMessage: (m: WorkletMsg) => env.sink(m) };
    }
  }
  // `currentTime` is a worklet global: route it to env so the test can advance the clock
  const factory = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'env', src.replace(/\bcurrentTime\b/g, 'env.currentTime'));
  factory(AudioWorkletProcessor, (_name: string, cls: unknown) => (env.registered = cls), SR, env);
  const Cls = env.registered as new (o: { processorOptions: Record<string, unknown> }) => WorkletProc;
  return { make: (opts = {}) => new Cls({ processorOptions: { windowSize: WIN, hop: HOP, fmin: 60, fmax: 1200, gate: 0.002, ...opts } }), env };
}
function runWorklet(signal: Float32Array, setup?: (p: WorkletProc) => void): WorkletMsg[] {
  const { make, env } = loadWorklet();
  const msgs: WorkletMsg[] = [];
  env.sink = (m) => msgs.push(m);
  const proc = make();
  setup?.(proc);
  for (let i = 0; i + 128 <= signal.length; i += 128) {
    env.currentTime = i / SR;
    proc.process([[signal.subarray(i, i + 128)]]);
  }
  return msgs;
}
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
function synth(seconds: number, hz: number, harmonics: number[], amp: number, noise: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * hz * i) / SR;
    let v = 0;
    for (let h = 1; h <= harmonics.length; h++) v += harmonics[h - 1] * Math.sin(h * ph);
    x[i] = amp * v + noise * rand();
  }
  return x;
}
const sawHarmonics = Array.from({ length: 20 }, (_, i) => 1 / (i + 1));
interface Tracked { t: number; hz: number; voicing: number; db: number; silent: boolean; hnr?: number; tilt?: number; centroid?: number; breathiness?: number; pressed?: number }
/** The main-thread half, exactly as MicAnalyzer does it: tracker → voice quality. Also returns naive YIN decisions. */
function trackMsgs(msgs: WorkletMsg[], ctx = { highMidi: 74, referenceDb: -25 }): { frames: Tracked[]; naive: number[] } {
  const tr = new PitchTracker<{ tCtx: number; silent: boolean; dips: Dip[]; m: WorkletMsg }>({ lookahead: 3 });
  const frames: Tracked[] = [];
  const naive: number[] = [];
  for (const m of msgs) {
    const dips: Dip[] = m.silent ? [] : m.hz!.map((h, i) => ({ hz: h, d: m.d![i] }));
    // the old rule: first dip under 0.15, else the deepest if under 0.5
    let nh = 0;
    if (!m.silent) {
      const first = dips.find((d) => d.d < 0.15);
      if (first) nh = first.hz;
      else {
        let best = dips[0];
        for (const d of dips) if (d.d < best.d) best = d;
        if (best && best.d < 0.5) nh = best.hz;
      }
    }
    naive.push(nh);
    const r = tr.push({ tCtx: m.t, silent: m.silent, dips, m });
    if (!r) continue;
    const im = r.input.m;
    const db = im.rms > 0 ? 20 * Math.log10(im.rms) : -100;
    const hz = r.voiced ? r.hz : 0;
    const f: Tracked = { t: r.input.tCtx, hz, voicing: r.voicing, db, silent: im.silent };
    if (!im.silent && im.bands) Object.assign(f, voiceQualityFor({ dPrime: r.d, bandsDb: im.bands, centroid: im.centroid ?? 0, db, midi: hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN, hz }, ctx));
    frames.push(f);
  }
  return { frames, naive };
}
const centsOff = (hz: number, ref: number) => Math.abs(1200 * Math.log2(hz / ref));
const isOctave = (hz: number, ref: number) => hz > 0 && Math.abs(centsOff(hz, ref) - 1200) < 60;
const med = (a: number[]) => median(a.filter((v) => v === v));
function describe(name: string, x: Float32Array, trueHz: number) {
  const msgs = runWorklet(x);
  const { frames, naive } = trackMsgs(msgs);
  const voiced = frames.filter((f) => f.hz > 0);
  const good = voiced.filter((f) => centsOff(f.hz, trueHz) < 30).length;
  const oct = voiced.filter((f) => isOctave(f.hz, trueHz)).length;
  const naiveOct = naive.filter((h) => isOctave(h, trueHz)).length;
  const q = {
    hnr: med(voiced.map((f) => f.hnr!)),
    tilt: med(voiced.map((f) => f.tilt!)),
    centroid: med(voiced.map((f) => f.centroid!)),
    breathiness: med(voiced.map((f) => f.breathiness!)),
    pressed: med(voiced.map((f) => f.pressed!)),
    voicing: med(frames.map((f) => f.voicing)),
    db: med(frames.map((f) => f.db)),
  };
  console.log(
    `  ${name}: ${frames.length} frames, ${voiced.length} voiced, ${good} within 30¢, ${oct} octave errors (naive YIN: ${naiveOct}); ` +
      `hnr ${q.hnr.toFixed(1)} tilt ${q.tilt.toFixed(1)} centroid ${q.centroid.toFixed(0)} breathiness ${q.breathiness.toFixed(2)} pressed ${q.pressed.toFixed(2)} voicing ${q.voicing.toFixed(2)} level ${q.db.toFixed(0)} dB`,
  );
  return { msgs, frames, voiced, good, oct, naiveOct, naive, ...q };
}
{
  const clean = describe('clean sawtooth A3', synth(2, 220, sawHarmonics, 0.1, 0), 220);
  check(clean.frames.length === clean.msgs.length - 3, `smoother delays by exactly 3 frames (${clean.msgs.length} in, ${clean.frames.length} out)`);
  check(clean.frames.every((f, i) => i === 0 || Math.abs(f.t - clean.frames[i - 1].t - HOP / SR) < 1e-6), 'frames are timestamped with their own window time, one hop apart');
  check(clean.good >= clean.frames.length - 3 && clean.oct === 0, 'clean tone: every frame after onset within 30 cents, no octave errors');
  check(clean.voicing > 0.95 && clean.hnr > 25 && clean.breathiness < 0.1, 'clean tone: voicing ≈ 1, high HNR, not breathy');
  check(Math.abs(clean.tilt + 6) < 2.5, `clean sawtooth tilt ≈ −6 dB/oct (${clean.tilt.toFixed(1)})`);
  check(clean.centroid > 300 && clean.centroid < 800, `clean sawtooth centroid ${clean.centroid.toFixed(0)} Hz`);

  const breathy = describe('same tone + white noise (breathy)', synth(2, 220, sawHarmonics, 0.1, 0.035), 220);
  check(breathy.good >= breathy.frames.length - 4 && breathy.oct === 0, 'breathy tone still tracked without octave errors');
  check(breathy.hnr < clean.hnr - 10 && breathy.breathiness > clean.breathiness + 0.1, `breathy tone: lower HNR (${breathy.hnr.toFixed(1)} vs ${clean.hnr.toFixed(1)}), higher breathiness (${breathy.breathiness.toFixed(2)} vs ${clean.breathiness.toFixed(2)})`);

  const pressed = describe('bright loud high E5 (pressed)', synth(2, 659.3, [1, 1, 1, 1, 1, 1, 1, 1], 0.12, 0), 659.3);
  check(pressed.good >= pressed.frames.length - 3, 'pressed tone tracked');
  check(pressed.pressed > clean.pressed + 0.3 && pressed.pressed > 0.8, `bright loud high tone is 'pressed' (${pressed.pressed.toFixed(2)} vs sawtooth ${clean.pressed.toFixed(2)})`);
  check(pressed.tilt > clean.tilt + 3 && pressed.centroid > clean.centroid * 2, 'pressed tone: shallower tilt and higher centroid than the sawtooth');

  const dull = describe('dull soft A3', synth(2, 220, [1, 0.3, 0.1, 0.03], 0.02, 0), 220);
  check(dull.good >= dull.frames.length - 3 && dull.pressed < 0.1, `dull soft tone is not pressed (${dull.pressed.toFixed(2)})`);

  // octave traps: weak fundamental, strong 2nd harmonic, quiet and noisy: naive YIN flips octaves
  const trapA = describe('octave trap G3 quiet+noise', synth(2, 196, [0.25, 1, 0.5, 0.3, 0.2, 0.1], 0.02, 0.012), 196);
  const trapB = describe('octave trap D3 quiet+noise', synth(2, 150, [0.15, 1, 0.3, 0.4, 0.1, 0.1], 0.015, 0.012), 150);
  const trapC = describe('octave trap A2 quiet+noise', synth(2, 110, [0.2, 1, 0.2, 0.5, 0.15, 0.2], 0.015, 0.012), 110);
  const traps = [trapA, trapB, trapC];
  const naiveErr = traps.reduce((a, t) => a + t.naiveOct, 0);
  const trackErr = traps.reduce((a, t) => a + t.oct, 0);
  const trackVoiced = traps.reduce((a, t) => a + t.voiced.length, 0);
  const trackGood = traps.reduce((a, t) => a + t.good, 0);
  check(naiveErr >= 20, `naive YIN makes octave errors on the traps (${naiveErr})`);
  check(trackErr <= Math.max(2, naiveErr * 0.1), `smoothed tracker makes far fewer (${trackErr})`);
  check(trackVoiced >= traps.reduce((a, t) => a + t.frames.length, 0) * 0.5 && trackGood >= trackVoiced * 0.95, `traps still tracked: ${trackGood}/${trackVoiced} voiced frames correct`);

  const silence = describe('silence', synth(1, 220, [1], 0, 0.0005), 220);
  check(silence.voiced.length === 0 && silence.frames.every((f) => f.silent && f.voicing === 0 && f.hnr === undefined), 'silence: silent frames, voicing 0, no voice-quality fields');
  const noise = describe('room noise only', synth(1, 220, [1], 0, 0.05), 220);
  check(noise.voiced.length === 0 && noise.frames.every((f) => f.voicing < 0.3), 'noise: no voiced frames, low voicing');
  check(noise.frames.every((f) => !f.silent && f.hnr !== undefined && f.hnr < 8 && f.breathiness! > 0.5), 'noise above the gate still reports voice quality (low HNR, airy)');
}
{
  // worklet spectrum measurements agree with the TypeScript reference on the same window
  const { make } = loadWorklet();
  const proc = make();
  const x = synth(1, 330, sawHarmonics, 0.1, 0.01).subarray(10000, 10000 + WIN);
  const got = proc.spectrum(x);
  const re = new Float64Array(WIN / 2 + 1);
  const im = new Float64Array(WIN / 2 + 1);
  const hann = Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  for (let k = 0; k <= WIN / 2; k++) {
    let sr = 0;
    let si = 0;
    for (let n = 0; n < WIN; n++) {
      const a = (-2 * Math.PI * k * n) / WIN;
      sr += x[n] * hann[n] * Math.cos(a);
      si += x[n] * hann[n] * Math.sin(a);
    }
    re[k] = sr;
    im[k] = si;
  }
  const power = re.map((r, k) => r * r + im[k] * im[k]);
  const refBands = bandPowersDb(power, SR / WIN);
  const refCentroid = spectralCentroid(power, SR / WIN);
  const maxDiff = Math.max(...refBands.map((b, i) => Math.abs(b - got.bands[i])));
  check(maxDiff < 0.05, `worklet band powers match the DFT reference (max diff ${maxDiff.toFixed(3)} dB)`);
  check(Math.abs(got.centroid - refCentroid) < 1, `worklet centroid matches the reference (${got.centroid.toFixed(1)} vs ${refCentroid.toFixed(1)} Hz)`);
}
{
  // onset detection for the latency measurement: clicks at known sample positions in light noise
  const n = 3 * SR;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.0008 * rand();
  const clickAt = [0.8, 1.5, 1.52, 2.2]; // the third is inside the refractory window of the second
  for (const at of clickAt) {
    const i0 = Math.round(at * SR);
    for (let k = 0; k < 0.02 * SR; k++) x[i0 + k] += 0.4 * Math.sin((2 * Math.PI * 2000 * k) / SR) * Math.min(1, k / 48) * Math.exp(-k / (0.01 * SR));
  }
  const msgs = runWorklet(x, (p) => p.port.onmessage!({ data: { onsets: true } }));
  const onsets = msgs.filter((m) => typeof m.onset === 'number').map((m) => m.onset!);
  console.log('  onsets detected at', onsets.map((o) => o.toFixed(4)).join(', '));
  check(onsets.length === 3, `3 of the 4 clicks reported (the 4th is within 250 ms of the 3rd): ${onsets.length}`);
  const errs = [0.8, 1.5, 2.2].map((at, i) => (onsets[i] !== undefined ? Math.abs(onsets[i] - at) * 1000 : 999));
  check(errs.every((e) => e < 0.5), `onset times within 0.5 ms (${errs.map((e) => e.toFixed(2)).join(', ')} ms)`);
  const res = latencyFromOnsets([0.8 - 0.07, 1.5 - 0.07, 2.2 - 0.07], onsets, 50);
  check(res.measured && res.latencyMs === 70, `end to end: clicks scheduled 70 ms before they were heard → ${res.latencyMs} ms`);
  // pitch messages keep flowing while onset detection is on
  check(msgs.some((m) => typeof m.onset !== 'number' && typeof m.t === 'number'), 'pitch frames still posted during onset detection');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
