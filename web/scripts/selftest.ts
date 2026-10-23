// Logic self-test: run with `npx tsx scripts/selftest.ts`
import { buildAnalysis } from '../src/lib/analysis/segment';
import { scorePhrase } from '../src/lib/scoring/score';
import { alignLyrics, parseLyrics } from '../src/lib/analysis/lyrics';
import { midiToHz, midiToName } from '../src/lib/music/notes';
import type { PitchFrame } from '../src/lib/types';

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
