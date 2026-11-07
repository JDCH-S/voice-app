// Logic self-test: run with `npx tsx scripts/selftest.ts`
import { buildAnalysis } from '../src/lib/analysis/segment';
import { scorePhrase } from '../src/lib/scoring/score';
import { alignLyrics, alignWords, parseLyrics, wordAt } from '../src/lib/analysis/lyrics';
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
import { midiToHz, midiToName } from '../src/lib/music/notes';
import type { AdaptiveSettings, PhraseAttempt, PitchFrame, Profile, RecordingRecord, ReviewState, SessionRecord, SongRecord } from '../src/lib/types';
import { analysisFromNotes, exerciseById, exerciseForIssue, EXERCISES, type NoteSpec } from '../src/lib/exercises/library';
import { detectTechnique, describeTechnique } from '../src/lib/scoring/technique';
import { defaultSettings, masteryFor, nextSettings } from '../src/lib/adaptive';
import { DAY_MS, dueReviews, firstAndLatest, updateReview } from '../src/lib/review';
import { KaraokeScorer, starsFor, multiplierFor } from '../src/lib/game';
import { dailyGoalMinutes, nextReminderAt, streakDays, todayMinutes, longestStreak } from '../src/lib/habits';
import { pitchCorrectChannels, planCorrections, encodeWav, type PitchShifter } from '../src/lib/audio/pitchCorrect';
import { buildPlan } from '../src/lib/plan';

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

// ---- word-level alignment (speech-recognition timing) ----
{
  const a2 = structuredClone(analysis);
  const words = [
    { t0: 0.52, t1: 0.98, text: 'hel', conf: 0.9 },
    { t0: 1.02, t1: 1.45, text: 'lo', conf: 0.9 },
    { t0: 1.55, t1: 2.5, text: 'friend', conf: 0.8 },
    { t0: 2.75, t1: 2.95, text: 'uh', conf: 0.3 }, // in the breath gap: no note overlaps, nearest note starts 0.05 s later
    { t0: 3.05, t1: 3.35, text: 'reach', conf: 0.9 },
    { t0: 3.42, t1: 3.78, text: 'the', conf: 0.9 },
    { t0: 3.85, t1: 4.9, text: 'top', conf: 0.9 },
    { t0: 5.58, t1: 5.7, text: 'la', conf: 0.7 },
    { t0: 5.75, t1: 5.82, text: 'la', conf: 0.7 },
    { t0: 6.1, t1: 6.9, text: 'down', conf: 0.9 },
  ];
  alignWords(a2, words);
  const byStart = (t: number) => a2.notes.find((n) => Math.abs(n.start - t) < 0.08)!;
  check(byStart(0.5).lyric === 'hel' && byStart(1.0).lyric === 'lo' && byStart(1.5).lyric === 'friend', `words land on the notes they overlap most (${byStart(0.5).lyric}, ${byStart(1.0).lyric}, ${byStart(1.5).lyric})`);
  check(byStart(3.0).lyric === 'uh reach', `a word in a gap joins the nearest note within 0.3 s ("${byStart(3.0).lyric}")`);
  check(byStart(3.8).lyric === 'top', `the slide note gets "top" ("${byStart(3.8).lyric}")`);
  check(a2.phrases[0].text === 'hel lo friend' && a2.phrases[1].text === 'uh reach the top', `phrase texts from words: "${a2.phrases[0].text}" / "${a2.phrases[1].text}"`);
  check(a2.phrases[2].text.startsWith('la la') && a2.phrases[2].text.endsWith('down'), `run phrase text: "${a2.phrases[2].text}"`);
  const empty = structuredClone(analysis);
  alignWords(empty, [], ly);
  check(empty.phrases[0].text.includes('hello'), 'alignWords with no words falls back to the line-based aligner');
  check(wordAt(words, 3.9)?.text === 'top' && wordAt(words, 2.6) === null && wordAt(words, 6.5)?.text === 'down', 'wordAt finds the word being sung');
}

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

// the classic singers carry no voice-quality fields: no technique issue may fire on them
for (const [name, r] of [['perfect', perfect], ['flat', flat], ['late', late], ['short', short], ['octave', oct]] as const) {
  const c = r.technique!.counts;
  check(c.breathy + c.strain + c.crack + c['out-of-air'] === 0 && r.technique!.score === 100, `${name} singer: no technique issues (summary present, score ${r.technique!.score})`);
}

// =====================================================================================
// Package B: technique detection
// =====================================================================================
console.log('\n--- technique ---');
const DT = 0.01;
type FrameShaper = (t: number, note: NoteSpec | null, idx: number) => Partial<PitchFrame> | null;
/** Synthesize frames for note specs; `shape` can override/add any field or return null for silence. */
function framesFor(specsIn: NoteSpec[], seconds: number, shape: FrameShaper = () => ({})): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (let t = 0; t < seconds; t += DT) {
    const idx = specsIn.findIndex((s) => t >= s.start && t < s.end);
    const note = idx >= 0 ? specsIn[idx] : null;
    const extra = shape(t, note, idx);
    if (!note || extra === null) {
      out.push({ t, hz: 0, midi: NaN, rms: 0.001, db: -60, clarity: 0 });
      continue;
    }
    const midi = extra.midi ?? note.midi;
    const f: PitchFrame = { t, hz: midiToHz(midi), midi, rms: 0.1, db: -20, clarity: 0.95, ...extra, midi };
    if (extra.midi !== undefined) f.hz = midiToHz(extra.midi);
    out.push(f);
  }
  return out;
}
const longNote: NoteSpec[] = [{ midi: 62, start: 0.5, end: 2.0, lyric: 'ah' }];
const techA = analysisFromNotes(longNote);
const techOpts = { semitones: 0, allowOctave: true };
const clean = detectTechnique(techA.notes, framesFor(longNote, 2.5, () => ({ breathiness: 0.2, hnr: 18, pressed: 0.2, voicing: 0.98, peak: 0.5 })), techOpts);
check(clean.issues.length === 0 && clean.summary.score === 100 && clean.summary.notesChecked === 1, `clean tone: no issues (score ${clean.summary.score})`);
check(clean.summary.fields.breathiness && clean.summary.fields.pressed && clean.summary.fields.peak, 'clean tone: fields detected as present');
check(describeTechnique(clean.summary) === null, 'describeTechnique is null when nothing is flagged');

const breathy = detectTechnique(techA.notes, framesFor(longNote, 2.5, () => ({ breathiness: 0.75, hnr: 5 })), techOpts);
check(breathy.issues.length === 1 && breathy.issues[0].kind === 'breathy', `breathy (index 0.75) flagged: ${breathy.issues[0]?.text}`);
const breathyHnr = detectTechnique(techA.notes, framesFor(longNote, 2.5, () => ({ hnr: 5 })), techOpts);
check(breathyHnr.issues.some((i) => i.kind === 'breathy'), 'breathy via HNR < 8 dB when no breathiness index');
const clearHnr = detectTechnique(techA.notes, framesFor(longNote, 2.5, () => ({ hnr: 16 })), techOpts);
check(clearHnr.issues.length === 0, 'HNR 16 dB is not breathy');
const borderline = detectTechnique(techA.notes, framesFor(longNote, 2.5, () => ({ breathiness: 0.55 })), techOpts);
check(borderline.issues.length === 0, 'breathiness 0.55 is under the threshold');
const shortNote: NoteSpec[] = [{ midi: 62, start: 0.5, end: 0.7 }];
const shortBreathy = detectTechnique(analysisFromNotes(shortNote).notes, framesFor(shortNote, 1.0, () => ({ breathiness: 0.9 })), techOpts);
check(shortBreathy.issues.length === 0, 'breathy rule skips notes under 0.3 s');

const pressed = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t) => ({ pressed: t > 1.0 && t < 1.4 ? 0.85 : 0.3 })), techOpts);
check(pressed.issues.length === 1 && pressed.issues[0].kind === 'strain' && pressed.summary.counts.strain === 1, `pressed 0.85 for 0.4 s flagged as strain: ${pressed.issues[0]?.text}`);
const pressedBrief = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t) => ({ pressed: t > 1.0 && t < 1.15 ? 0.9 : 0.3 })), techOpts);
check(pressedBrief.issues.length === 0, 'pressed for only 0.15 s is not strain');
const clipping = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t) => ({ peak: t > 0.8 && t < 1.6 ? 0.99 : 0.6 })), { ...techOpts, highMidi: 63 });
check(clipping.issues.some((i) => i.kind === 'strain' && i.text.includes('clipped')), 'clipping on a high note flagged as strain');
const clipLow = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t) => ({ peak: t > 0.8 && t < 1.6 ? 0.99 : 0.6 })), { ...techOpts, highMidi: 75 });
check(clipLow.issues.length === 0, 'clipping on a comfortable note is not strain');

// crack: a +7 semitone flip for 80 ms with a dropout frame around it
const crackShape: FrameShaper = (t) => {
  if (t >= 1.195 && t < 1.205) return null; // one unvoiced frame (dropout)
  if (t >= 1.2 && t < 1.28) return { midi: 69, clarity: 0.9 };
  return {};
};
const cracked = detectTechnique(techA.notes, framesFor(longNote, 2.5, crackShape), techOpts);
check(cracked.issues.length === 1 && cracked.issues[0].kind === 'crack', `crack flagged (no voice-quality fields needed): ${cracked.issues[0]?.text}`);
const crackClarity = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t) => (t >= 1.19 && t < 1.21 ? { clarity: 0.55 } : t >= 1.2 && t < 1.28 ? { midi: 69 } : {})), techOpts);
check(crackClarity.issues.some((i) => i.kind === 'crack'), 'crack with a clarity collapse instead of a dropout');
const jumpNoDrop = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t) => (t >= 1.2 && t < 1.28 ? { midi: 69 } : {})), techOpts);
check(jumpNoDrop.issues.length === 0, 'a clean jump without dropout or clarity collapse is not a crack');
const octaveDown = detectTechnique(techA.notes, framesFor(longNote, 2.5, () => ({ midi: 50 })), techOpts);
check(octaveDown.issues.length === 0, 'steady octave-down singing is not a crack');
const crackShortNote: NoteSpec[] = [{ midi: 62, start: 0.5, end: 0.85 }];
const crackShort = detectTechnique(analysisFromNotes(crackShortNote).notes, framesFor(crackShortNote, 1.2, (t) => (t >= 0.645 && t < 0.655 ? null : t >= 0.65 && t < 0.73 ? { midi: 69 } : {})), techOpts);
check(crackShort.issues.length === 0, 'crack rule skips notes under 0.4 s');

// out of air: level drops 12 dB and pitch sags 40 cents over the last 40 %
const fading = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t, nt) => {
  if (!nt) return {};
  const p = (t - nt.start) / (nt.end - nt.start);
  const k = p > 0.6 ? (p - 0.6) / 0.4 : 0;
  return { db: -20 - 12 * k, midi: nt.midi - 0.4 * k };
}), techOpts);
check(fading.issues.length === 1 && fading.issues[0].kind === 'out-of-air', `fading note flagged out of air: ${fading.issues[0]?.text}`);
const fadingNoSag = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t, nt) => {
  if (!nt) return {};
  const p = (t - nt.start) / (nt.end - nt.start);
  return { db: -20 - (p > 0.6 ? 12 * ((p - 0.6) / 0.4) : 0) };
}), techOpts);
check(fadingNoSag.issues.length === 0, 'a controlled decrescendo without pitch sag is not out of air');
const fadeShortNote: NoteSpec[] = [{ midi: 62, start: 0.5, end: 1.3 }];
const fadeShort = detectTechnique(analysisFromNotes(fadeShortNote).notes, framesFor(fadeShortNote, 1.6, (t, nt) => {
  if (!nt) return {};
  const p = (t - nt.start) / (nt.end - nt.start);
  const k = p > 0.6 ? (p - 0.6) / 0.4 : 0;
  return { db: -20 - 12 * k, midi: nt.midi - 0.4 * k };
}), techOpts);
check(fadeShort.issues.length === 0, 'out-of-air rule skips notes under 1 s');

// everything at once, and graceful degradation without fields
const everything = detectTechnique(techA.notes, framesFor(longNote, 2.5, (t, nt) => {
  if (!nt) return {};
  const p = (t - nt.start) / (nt.end - nt.start);
  const k = p > 0.6 ? (p - 0.6) / 0.4 : 0;
  return { breathiness: 0.8, pressed: 0.9, db: -20 - 12 * k, midi: nt.midi - 0.4 * k };
}), techOpts);
check(everything.summary.counts.breathy === 1 && everything.summary.counts.strain === 1 && everything.summary.counts['out-of-air'] === 1 && everything.summary.score < 60, `three issues on one note: score ${everything.summary.score}, "${describeTechnique(everything.summary)}"`);
const noFields = detectTechnique(techA.notes, framesFor(longNote, 2.5), techOpts);
check(noFields.issues.length === 0 && !noFields.summary.fields.breathiness && !noFields.summary.fields.pressed, 'no voice-quality fields: field-based rules stay silent');
const unsung = detectTechnique(techA.notes, framesFor(longNote, 2.5, () => null), techOpts);
check(unsung.issues.length === 0 && unsung.summary.notesChecked === 0, 'a note that was not sung is not checked');

// wired into scorePhrase: issues, expression penalty, summary, tip
const techPhrase = techA.phrases[0];
const cleanScore = scorePhrase(techA, techPhrase, framesFor(longNote, 2.5, () => ({ breathiness: 0.2, pressed: 0.2 })), base);
const strainScore = scorePhrase(techA, techPhrase, framesFor(longNote, 2.5, () => ({ breathiness: 0.2, pressed: 0.9 })), base);
check(cleanScore.technique!.score === 100 && cleanScore.scores.overall >= 90, `scorePhrase clean long tone: ${cleanScore.scores.overall}`);
check(strainScore.issues.some((i) => i.kind === 'strain') && strainScore.technique!.counts.strain === 1, 'scorePhrase carries the strain issue and summary');
check(strainScore.scores.expression < cleanScore.scores.expression, `strain lowers expression (${cleanScore.scores.expression} → ${strainScore.scores.expression})`);
check(strainScore.tip.title.includes('straining') && strainScore.tip.exerciseId === 'sirens', `strain wins the tip: "${strainScore.tip.title}"`);
const breathyScore = scorePhrase(techA, techPhrase, framesFor(longNote, 2.5, () => ({ breathiness: 0.8 })), base);
check(breathyScore.tip.exerciseId === 'clear-tone' && !!exerciseById('clear-tone'), 'breathy tip points at the Clear tone exercise, which exists');
const missedScore = scorePhrase(techA, techPhrase, framesFor(longNote, 2.5, () => null), base);
check(missedScore.technique!.notesChecked === 0 && missedScore.issues.every((i) => i.kind === 'missed'), 'missed notes are not technique-checked in scorePhrase');

// =====================================================================================
// adaptive difficulty
// =====================================================================================
console.log('\n--- adaptive ---');
function attemptWith(score: number, tempo: number, i = 0): PhraseAttempt {
  return {
    id: `a${i}`, songId: 's', phraseIndex: 0, date: i, semitones: 0, tempo,
    scores: { pitch: score, timing: score, length: score, expression: score, overall: score },
    issues: [], tip: { title: '', detail: '', exerciseId: null }, frames: [], noteResults: [],
  };
}
const adv0 = defaultSettings('advanced');
check(adv0.tempo === 1 && adv0.guide === false, 'advanced starts at 100% with the guide off');
check(defaultSettings('beginner').guide === true, 'beginner starts with the guide on');
let cur: AdaptiveSettings = { tempo: 1, guide: false, loop: false, reason: '' };
const history: PhraseAttempt[] = [];
const one = nextSettings([attemptWith(40, 1)], cur, 'intermediate');
check(one.tempo === 1 && one.guide === false, `one bad score changes nothing: "${one.reason}"`);
history.push(attemptWith(40, 1, 1), attemptWith(50, 1, 2));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 0.85 && cur.guide === true && cur.reason.includes('85%'), `two scores < 60 → 85% with the guide: "${cur.reason}"`);
history.push(attemptWith(30, 0.85, 3), attemptWith(35, 0.85, 4));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 0.7, `again → 70% (${cur.tempo})`);
history.push(attemptWith(30, 0.7, 5), attemptWith(35, 0.7, 6));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 0.5, `again → 50% (${cur.tempo})`);
history.push(attemptWith(30, 0.5, 7), attemptWith(35, 0.5, 8));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 0.5 && cur.guide === true, `never slower than 50%: "${cur.reason}"`);
const mixed = nextSettings([...history, attemptWith(70, 0.5, 9), attemptWith(72, 0.5, 10)], cur, 'intermediate');
check(mixed.tempo === 0.5 && mixed.guide === true, `middling scores keep the settings: "${mixed.reason}"`);
history.push(attemptWith(88, 0.5, 11), attemptWith(90, 0.5, 12));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 0.7 && cur.guide === true, `two ≥ 85 → speed up to 70%, guide still on: "${cur.reason}"`);
history.push(attemptWith(88, 0.7, 13), attemptWith(90, 0.7, 14));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 0.85, `→ 85% (${cur.tempo})`);
history.push(attemptWith(88, 0.85, 15), attemptWith(90, 0.85, 16));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 1 && cur.guide === true, `→ 100%, guide still on (${cur.tempo}, guide ${cur.guide})`);
history.push(attemptWith(88, 1, 17), attemptWith(90, 1, 18));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 1 && cur.guide === false, `then guide off: "${cur.reason}"`);
history.push(attemptWith(92, 1, 19), attemptWith(95, 1, 20));
cur = nextSettings(history, cur, 'intermediate');
check(cur.tempo === 1 && cur.guide === false && cur.loop === false && cur.reason.includes('Move on'), `mastered: "${cur.reason}"`);
const onlyOld = nextSettings([attemptWith(40, 1, 1), attemptWith(40, 1, 2), attemptWith(95, 0.85, 3)], { tempo: 0.85, guide: true, loop: true, reason: '' }, 'beginner');
check(onlyOld.tempo === 0.85, `scores at another tempo do not count as "at the current settings" (${onlyOld.tempo})`);
check(masteryFor([]) === 'new' && masteryFor([50]) === 'learning' && masteryFor([80, 78]) === 'learned' && masteryFor([91, 92, 95]) === 'mastered' && masteryFor([95, 60]) === 'learning', 'masteryFor ladder');

// =====================================================================================
// spaced review
// =====================================================================================
console.log('\n--- review ---');
const T0 = new Date(2026, 0, 1, 10, 0).getTime();
let rs = updateReview(null, 92, T0, { songId: 's1', phraseIndex: 2 });
check(rs.songId === 's1' && rs.phraseIndex === 2 && rs.intervalDays >= 1 && rs.intervalDays <= 1.3 && rs.mastery === 'learning', `first review at ${rs.intervalDays} days (${rs.mastery})`);
const ivs: number[] = [rs.intervalDays];
let now = T0;
for (let i = 0; i < 5; i++) {
  now = rs.dueAt + 3600000; // review an hour after it was due
  rs = updateReview(rs, 85, now);
  ivs.push(rs.intervalDays);
}
console.log('  intervals at score 85:', ivs.join(' → '));
check(ivs.every((v, i) => i === 0 || v >= ivs[i - 1]) && ivs.slice(0, 5).every((v, i) => i === 0 || v > ivs[i - 1]) && ivs[ivs.length - 1] <= 45, 'intervals grow up the ladder (1 → 3 → 7 → 14 → 30) and then hold');
check(Math.abs(ivs[1] - 3) < 0.01 && Math.abs(ivs[2] - 7) < 0.01 && Math.abs(ivs[3] - 14) < 0.01 && Math.abs(ivs[4] - 30) < 0.01, `score 85 keeps the ladder exactly: ${ivs.slice(1, 5).join(', ')}`);
check(rs.mastery === 'mastered' && rs.bestScore === 92, `after five good reviews: ${rs.mastery}, best ${rs.bestScore}`);
const reset = updateReview(rs, 55, now + DAY_MS);
check(reset.intervalDays === 1 && reset.mastery === 'learning' && reset.dueAt === now + 2 * DAY_MS, 'a score < 70 resets to 1 day and mastery to learning');
const hiScale = updateReview(null, 100, T0, { songId: 'x', phraseIndex: 0 });
const loScale = updateReview(null, 70, T0, { songId: 'x', phraseIndex: 0 });
check(hiScale.intervalDays > loScale.intervalDays, `interval scales with score (${loScale.intervalDays} at 70 vs ${hiScale.intervalDays} at 100)`);
const states: ReviewState[] = [
  { songId: 's', phraseIndex: 0, mastery: 'mastered', bestScore: 95, lastScore: 95, lastPracticed: 0, dueAt: T0 - 1 * DAY_MS, intervalDays: 30 },
  { songId: 's', phraseIndex: 1, mastery: 'learning', bestScore: 60, lastScore: 55, lastPracticed: 0, dueAt: T0 - 1 * DAY_MS, intervalDays: 1 },
  { songId: 's', phraseIndex: 2, mastery: 'learned', bestScore: 80, lastScore: 78, lastPracticed: 0, dueAt: T0 - 6 * DAY_MS, intervalDays: 3 },
  { songId: 's', phraseIndex: 3, mastery: 'learning', bestScore: 60, lastScore: 50, lastPracticed: 0, dueAt: T0 + 2 * DAY_MS, intervalDays: 1 },
];
const due = dueReviews(states, T0, 10);
check(due.length === 3 && !due.some((d) => d.phraseIndex === 3), `only due reviews are returned (${due.length})`);
check(due[0].phraseIndex === 2 && due[1].phraseIndex === 1 && due[2].phraseIndex === 0, `ordered most overdue / lowest mastery first: ${due.map((d) => d.phraseIndex).join(',')}`);
check(dueReviews(states, T0, 1).length === 1, 'limit respected');
const recs: RecordingRecord[] = [3, 1, 2].map((d) => ({ id: `r${d}`, songId: 's', date: d, kind: 'phrase', phraseIndex: 1, blob: null as unknown as Blob, mime: 'audio/webm', startSongTime: 0, tempo: 1, semitones: 0, frames: [], scores: { pitch: 0, timing: 0, length: 0, expression: 0, overall: 0 } }));
recs.push({ ...recs[0], id: 'full', kind: 'full', phraseIndex: null, date: 9 });
const fl = firstAndLatest(recs, 1)!;
check(fl.first.id === 'r1' && fl.latest.id === 'r3' && fl.count === 3, 'firstAndLatest picks the oldest and newest take of the phrase');
check(firstAndLatest(recs, null)!.first.id === 'full' && firstAndLatest(recs, 7) === null, 'firstAndLatest: full runs when null, null when nothing');

// =====================================================================================
// karaoke game
// =====================================================================================
console.log('\n--- game ---');
check(starsFor(95) === 5 && starsFor(94.9) === 4 && starsFor(85) === 4 && starsFor(70) === 3 && starsFor(55) === 2 && starsFor(35) === 1 && starsFor(34) === 0, 'starsFor thresholds');
check(multiplierFor(0) === 1 && multiplierFor(4) === 1 && multiplierFor(5) === 2 && multiplierFor(15) === 4 && multiplierFor(100) === 4, 'multiplier ×1..×4');
function playGame(frames: PitchFrame[]) {
  const g = new KaraokeScorer(analysis, { semitones: 0, level: 'intermediate', tempo: 1 });
  const events = frames.flatMap((f) => g.feed(f));
  return { g, events, result: g.finish() };
}
const gPerfect = playGame(sing({}));
const gSloppy = playGame(sing({ cents: 90 }));
const gSilent = playGame(sing({}).map((f) => ({ ...f, hz: 0, midi: NaN, clarity: 0 })));
console.log('  perfect:', JSON.stringify({ ...gPerfect.result, perPhrase: gPerfect.result.perPhrase.map((p) => `${p.score}/${p.stars}★`) }));
console.log('  sloppy:', JSON.stringify({ score: gSloppy.result.score, points: gSloppy.result.points, stars: gSloppy.result.stars, maxCombo: gSloppy.result.maxCombo }));
check(gPerfect.result.score >= 90 && gPerfect.result.stars >= 4, `perfect singer: score ${gPerfect.result.score}, ${gPerfect.result.stars} stars`);
check(gPerfect.result.maxCombo >= 10 && gPerfect.result.maxCombo <= analysis.notes.length, `perfect singer combo ${gPerfect.result.maxCombo} of ${analysis.notes.length} notes`);
check(gPerfect.result.perPhrase.length === analysis.phrases.length && gPerfect.result.perPhrase.every((p) => p.stars >= 4), 'perfect singer: every phrase ≥ 4 stars');
check(gPerfect.events.filter((e) => e.type === 'phrase').length === analysis.phrases.length, 'a phrase event per phrase while playing');
check(gPerfect.events.some((e) => e.type === 'multiplier' && e.multiplier === 2), 'multiplier grows with the combo');
check(gSloppy.result.score < 35 && gSloppy.result.stars === 0 && gSloppy.result.maxCombo === 0, `sloppy singer (90 cents off): score ${gSloppy.result.score}, 0 stars, no combo`);
check(gSloppy.result.points < gPerfect.result.points * 0.1, `sloppy points ${gSloppy.result.points} ≪ perfect ${gPerfect.result.points}`);
check(gSilent.result.score === 0 && gSilent.result.points === 0, 'silence scores nothing');
const sameFrames = sing({ cents: 20 });
check(JSON.stringify(playGame(sameFrames).result) === JSON.stringify(playGame(sameFrames).result), 'deterministic: same frames → identical result');
// combo break: on pitch for the first phrase, off pitch for > 0.3 s inside the long C5
const breakFrames = sing({}).map((f) => (f.t > 4.2 && f.t < 4.7 && f.hz > 0 ? { ...f, midi: f.midi + 3, hz: f.hz * Math.pow(2, 3 / 12) } : f));
const gBreak = playGame(breakFrames);
check(gBreak.events.some((e) => e.type === 'combo-break') && gBreak.result.maxCombo < gPerfect.result.maxCombo, `off pitch for 0.5 s breaks the combo (max ${gBreak.result.maxCombo})`);
const gOct = playGame(sing({ octave: -1 }));
check(gOct.result.score >= 90, `octave-down singing is accepted in the game (${gOct.result.score})`);
const liveState = (() => {
  const g = new KaraokeScorer(analysis, { semitones: 0, level: 'intermediate', tempo: 1 });
  for (const f of sing({})) if (f.t < 2.0) g.feed(f);
  return g.state;
})();
check(liveState.points > 0 && liveState.onPitchRatio > 0.9 && liveState.phraseIndex === 0 && liveState.multiplier >= 1, `live state mid-song: ${JSON.stringify({ points: liveState.points, combo: liveState.combo, ratio: liveState.onPitchRatio.toFixed(2) })}`);

// =====================================================================================
// habits
// =====================================================================================
console.log('\n--- habits ---');
function sess(y: number, mo: number, d: number, h: number, minutes: number, i: number): SessionRecord {
  const st = new Date(y, mo, d, h, 0).getTime();
  return { id: `s${i}`, startedAt: st, endedAt: st + minutes * 60000, activeSeconds: minutes * 60, songIds: [], phraseAttemptIds: [], exerciseResultIds: [], recap: null };
}
const NOW = new Date(2026, 10, 6, 15, 30).getTime(); // Fri 6 Nov 2026, 15:30 local
const sessions: SessionRecord[] = [
  sess(2026, 10, 3, 9, 12, 1),
  sess(2026, 10, 4, 23, 8, 2), // 23:00, counts for the 4th
  sess(2026, 10, 5, 0, 5, 3), // 00:00 on the 5th: a new day
  sess(2026, 10, 6, 7, 3, 4),
  sess(2026, 10, 6, 14, 4, 5),
  sess(2026, 9, 30, 10, 20, 6), // 30 Oct: streak broken on the 1st/2nd
];
check(streakDays(sessions, NOW) === 4, `streak across day boundaries = ${streakDays(sessions, NOW)} (expected 4)`);
check(streakDays(sessions, new Date(2026, 10, 7, 8, 0).getTime()) === 4, 'streak survives until the next day has passed');
check(streakDays(sessions, new Date(2026, 10, 8, 8, 0).getTime()) === 0, 'streak is 0 after a missed day');
check(streakDays(sessions.filter((s) => s.id !== 's3'), NOW) === 1, 'a gap day breaks the streak (3rd, 4th, [gap], 6th → 1)');
check(streakDays([{ ...sess(2026, 10, 6, 7, 1, 9), activeSeconds: 30 }], NOW) === 0, 'under 60 s does not count');
check(Math.abs(todayMinutes(sessions, NOW) - 7) < 0.01, `todayMinutes = ${todayMinutes(sessions, NOW)} (expected 7)`);
check(todayMinutes(sessions, new Date(2026, 10, 4, 23, 59).getTime()) === 8 && todayMinutes(sessions, new Date(2026, 10, 5, 0, 1).getTime()) === 5, 'todayMinutes respects local midnight');
check(longestStreak(sessions) === 4, `longest streak ${longestStreak(sessions)}`);
check(dailyGoalMinutes(null) === 10 && dailyGoalMinutes({ dailyGoalMinutes: 15 }) === 15 && dailyGoalMinutes({ dailyGoalMinutes: 0 }) === 10, 'dailyGoalMinutes default 10');
const rem1 = nextReminderAt({ reminderTime: '18:30' }, NOW)!;
const rem2 = nextReminderAt({ reminderTime: '09:00' }, NOW)!;
check(new Date(rem1).getDate() === 6 && new Date(rem1).getHours() === 18 && new Date(rem1).getMinutes() === 30, 'reminder later today');
check(new Date(rem2).getDate() === 7 && new Date(rem2).getHours() === 9, 'reminder time already passed → tomorrow');
check(nextReminderAt({ reminderTime: null }, NOW) === null && nextReminderAt({ reminderTime: '25:00' }, NOW) === null, 'no / malformed reminder → null');

// =====================================================================================
// pitch-corrected replay
// =====================================================================================
console.log('\n--- pitchCorrect ---');
const pcSpecs: NoteSpec[] = [
  { midi: 60, start: 0.5, end: 1.0 },
  { midi: 64, start: 1.0, end: 1.5 }, // legato join with the previous note
  { midi: 67, start: 2.0, end: 3.0 },
];
const pcA = analysisFromNotes(pcSpecs);
const sharpFrames = framesFor(pcSpecs, 3.5, (_t, nt) => (nt ? { midi: nt.midi + 0.3 } : {}));
const plan = planCorrections(sharpFrames, pcA, { semitones: 0, startSongTime: 0, tempo: 1 });
check(plan.length === 3 && plan.every((r) => Math.abs(r.cents - 30) < 3), `sharp singer: 3 regions of ≈ +30 cents (${plan.map((r) => r.cents.toFixed(0)).join(',')})`);
check(plan.every((r, i) => i === 0 || r.start >= plan[i - 1].end - 1e-9), 'regions never overlap');
const inTune = planCorrections(framesFor(pcSpecs, 3.5), pcA, { semitones: 0, startSongTime: 0, tempo: 1 });
check(inTune.length === 0, 'in-tune singer: nothing to fix');
const octPlan = planCorrections(framesFor(pcSpecs, 3.5, (_t, nt) => (nt ? { midi: nt.midi - 12 - 0.2 } : {})), pcA, { semitones: 0, startSongTime: 0, tempo: 1 });
check(octPlan.length === 3 && octPlan.every((r) => Math.abs(r.cents + 20) < 3), `octave-down singer is corrected to the nearest octave only (${octPlan.map((r) => r.cents.toFixed(0)).join(',')})`);
const skipPlan = planCorrections(framesFor(pcSpecs, 3.5, (_t, nt, idx) => (idx === 1 ? null : nt ? { midi: nt.midi + 0.3 } : {})), pcA, { semitones: 0, startSongTime: 0, tempo: 1 });
check(skipPlan.length === 2 && !skipPlan.some((r) => r.noteId === 1), 'an unsung note is left untouched');
// the recording started at song time 0.4 at 70 % tempo: recording time = (song − 0.4) / 0.7
const slowPlan = planCorrections(sharpFrames, pcA, { semitones: 0, startSongTime: 0.4, tempo: 0.7 });
check(Math.abs(slowPlan[0].start - (0.5 - 0.4) / 0.7) < 1e-6 && Math.abs(slowPlan[2].end - (3.0 - 0.4) / 0.7) < 0.02, `recording-time mapping with startSongTime and tempo (${slowPlan[0].start.toFixed(3)} .. ${slowPlan[2].end.toFixed(3)})`);
const transposed2 = planCorrections(framesFor(pcSpecs, 3.5, (_t, nt) => (nt ? { midi: nt.midi - 3 + 0.25 } : {})), pcA, { semitones: -3, startSongTime: 0, tempo: 1 });
check(transposed2.length === 3 && transposed2.every((r) => Math.abs(r.cents - 25) < 3), 'transposed reference: error measured against the transposed target');
const lateFrames = framesFor(pcSpecs.map((s) => ({ ...s, start: s.start + 0.12, end: s.end + 0.12 })), 3.5, (_t, nt) => (nt ? { midi: nt.midi + 0.3 } : {}));
const latePlan = planCorrections(lateFrames, pcA, { semitones: 0, startSongTime: 0, tempo: 1 });
check(latePlan.length === 3 && latePlan[2].end > 3.0 + 0.1 && latePlan[2].end <= 3.5, `late singer: the region follows the sung tail (${latePlan[2].end.toFixed(2)})`);
const fromResults = planCorrections(sharpFrames, pcA, { semitones: 0, startSongTime: 0, tempo: 1, noteResults: [
  { noteId: 0, sungMidi: 60.4, centsError: 40, onsetDelta: 0, heldRatio: 1, coverage: 1, status: 'sharp' },
  { noteId: 1, sungMidi: null, centsError: null, onsetDelta: null, heldRatio: null, coverage: 0, status: 'missed' },
  { noteId: 2, sungMidi: 67, centsError: 2, onsetDelta: 0, heldRatio: 1, coverage: 1, status: 'good' },
] });
check(fromResults.length === 1 && fromResults[0].noteId === 0 && fromResults[0].cents === 40, 'attempt note results are used when given (missed and in-tune notes skipped)');

// DSP core on synthetic channels
const SRB = 8000;
const sine = (hz: number, n: number, sr = SRB) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / sr));
const identity: PitchShifter = { shift: async (ch) => ch.map((c) => Float32Array.from(c)) };
const negate: PitchShifter = { shift: async (ch) => ch.map((c) => c.map((v) => -v)) };
const shortOut: PitchShifter = { shift: async (ch) => ch.map((c) => c.slice(0, Math.max(0, c.length - Math.round(SRB * 0.05))).map((v) => -v)) };
/** Naive resampler: changes pitch (and length) like a tape machine; good enough to check the join logic. */
const tape: PitchShifter = {
  shift: async (ch, sr, semis) => {
    const rate = Math.pow(2, semis / 12);
    return ch.map((c) => {
      const n = Math.floor(c.length / rate);
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i * rate;
        const k = Math.floor(x);
        const fr = x - k;
        o[i] = (c[k] ?? 0) * (1 - fr) + (c[k + 1] ?? c[k] ?? 0) * fr;
      }
      return o;
    });
  },
};
const input = [sine(220, 2 * SRB), sine(220, 2 * SRB).map((v) => v * 0.5)];
const regions = [
  { noteId: 0, start: 0.5, end: 1.0, cents: 30 },
  { noteId: 1, start: 1.0, end: 1.5, cents: -40 },
];
const same = await pitchCorrectChannels(input, SRB, regions, identity);
check(same.length === 2 && same[0].length === input[0].length && same[0].every((v, i) => Math.abs(v - input[0][i]) < 1e-7) && same[1].every((v, i) => Math.abs(v - input[1][i]) < 1e-7), 'identity shifter: output equals input, same length and channel count');
check(same[0] !== input[0] && input[0][SRB] === sine(220, 2 * SRB)[SRB], 'input channels are not modified');
const neg = await pitchCorrectChannels(input, SRB, regions, negate);
const F = Math.round(SRB * 0.01);
const at = (s: number) => Math.round(s * SRB);
check(neg[0].length === input[0].length, 'negate shifter: length preserved');
check(neg[0][at(0.25)] === input[0][at(0.25)] && neg[0][at(1.75)] === input[0][at(1.75)], 'outside the regions the original is untouched');
check(Math.abs(neg[0][at(0.75)] + input[0][at(0.75)]) < 1e-6 && Math.abs(neg[0][at(1.25)] + input[0][at(1.25)]) < 1e-6, 'inside both regions the shifted audio replaces the original');
check(Math.abs(neg[1][at(0.75)] + input[1][at(0.75)]) < 1e-6, 'second channel processed too');
// at the legato join (1.0 s) two shifted regions crossfade into each other: no original leaks in
check(Math.abs(neg[0][at(1.0)] + input[0][at(1.0)]) < 1e-6 && Math.abs(neg[0][at(1.0) - F / 2] + input[0][at(1.0) - F / 2]) < 1e-6 && Math.abs(neg[0][at(1.0) + F / 2] + input[0][at(1.0) + F / 2]) < 1e-6, 'adjacent regions join without the original leaking in');
// the fade-in at 0.5 s and the fade-out at 1.5 s are 10 ms ramps: mixes of original and shifted
const ramp = (s: number) => {
  const i = at(s);
  const o = input[0][i];
  const w = o !== 0 ? (o - neg[0][i]) / (2 * o) : NaN; // weight of the shifted (negated) signal
  return w;
};
const wIn = ramp(0.5 - 0.005);
const wOut = ramp(1.5 + 0.005);
check(wIn > 0.3 && wIn < 0.7 && wOut > 0.3 && wOut < 0.7, `10 ms crossfades at the outer joins (weights ${wIn.toFixed(2)}, ${wOut.toFixed(2)})`);
check(ramp(0.5 - 0.012) < 0.01 && ramp(1.5 + 0.012) < 0.01, 'crossfade is confined to 10 ms');
const shortRes = await pitchCorrectChannels(input, SRB, regions, shortOut);
check(shortRes[0].length === input[0].length && Math.abs(shortRes[0][at(1.49)] + input[0][at(1.49)]) < 1e-6, 'a shifter that returns 50 ms less is still fitted over the whole region (extra source margin)');
const empty = await pitchCorrectChannels(input, SRB, [], identity);
check(empty[0].length === input[0].length, 'no regions: unchanged copy');
const tiny = await pitchCorrectChannels(input, SRB, [{ noteId: 0, start: 0.5, end: 0.505, cents: 30 }], negate);
check(tiny[0].every((v, i) => v === input[0][i]), 'regions shorter than 20 ms are skipped');
// real pitch change with the tape shifter: measure the frequency by zero crossings in the region
const zc = (x: Float32Array, a: number, b: number) => {
  let c = 0;
  for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) c++;
  return (c / 2) / ((b - a) / SRB);
};
const taped = await pitchCorrectChannels([sine(220, 2 * SRB)], SRB, [{ noteId: 0, start: 0.5, end: 1.5, cents: -200 }], tape); // 200 cents flat → shift up 2 semitones
const fIn = zc(taped[0], at(0.55), at(1.4));
const fOut = zc(taped[0], at(0.0), at(0.45));
const fExp = 220 * Math.pow(2, 2 / 12);
check(Math.abs(fIn - fExp) < 4 && Math.abs(fOut - 220) < 3, `tape shifter: ${fIn.toFixed(1)} Hz inside (expected ${fExp.toFixed(1)}), ${fOut.toFixed(1)} Hz outside`);
check(taped[0].length === 2 * SRB, 'total length unchanged after a real pitch shift');
const wav = encodeWav([sine(440, 800)], SRB);
check(wav.size === 44 + 800 * 2 && wav.type === 'audio/wav', `WAV encoder: ${wav.size} bytes`);

// =====================================================================================
// plan: review items; exercises
// =====================================================================================
console.log('\n--- plan & exercises ---');
const profile: Profile = { id: 'me', createdAt: 0, name: 'T', level: 'intermediate', goals: ['sing-songs'], rangeTests: [{ date: Date.now(), lowMidi: 48, highMidi: 72, voiceType: 'Tenor', accuracyCents: 10, stabilityCents: 5, accuracyScore: 90 }], calibration: null, allowOctave: true, onboardingDone: true };
const songRec: SongRecord = { id: 'song1', createdAt: 0, title: 'Test song', artist: 'A', duration: 8, analysis, lyrics: { source: 'none', synced: false, lines: [] }, mode: 'separated', hasStems: false, preferredSemitones: 0, recommendedSemitones: 0, jobId: null };
const noReviewPlan = buildPlan(profile, [], [], [songRec]);
check(noReviewPlan[0].kind === 'warmup' && !noReviewPlan.some((i) => i.kind === 'review'), 'buildPlan without reviews is unchanged (warm-up first, no review items)');
const planNow = Date.now();
const reviewStates: ReviewState[] = [
  { songId: 'song1', phraseIndex: 1, mastery: 'learning', bestScore: 65, lastScore: 60, lastPracticed: planNow - 2 * DAY_MS, dueAt: planNow - DAY_MS, intervalDays: 1 },
  { songId: 'song1', phraseIndex: 0, mastery: 'mastered', bestScore: 95, lastScore: 95, lastPracticed: planNow - 31 * DAY_MS, dueAt: planNow - 0.5 * DAY_MS, intervalDays: 30 },
  { songId: 'song1', phraseIndex: 2, mastery: 'learned', bestScore: 80, lastScore: 80, lastPracticed: planNow, dueAt: planNow + 3 * DAY_MS, intervalDays: 3 },
  { songId: 'gone', phraseIndex: 0, mastery: 'learning', bestScore: 10, lastScore: 10, lastPracticed: 0, dueAt: planNow - 9 * DAY_MS, intervalDays: 1 },
];
const withReviews = buildPlan(profile, [], [], [songRec], reviewStates, planNow);
const reviewIdx = withReviews.map((i, k) => (i.kind === 'review' ? k : -1)).filter((k) => k >= 0);
check(reviewIdx.length === 2 && reviewIdx[0] === 1 && reviewIdx[1] === 2, `two due reviews right after the warm-up (positions ${reviewIdx.join(',')}); deleted song skipped`);
check(withReviews[1].phraseIndex === 1 && withReviews[1].songId === 'song1' && withReviews[1].title.includes('phrase 2') && withReviews[1].why.includes('overdue'), `most urgent review first: "${withReviews[1].title}" (${withReviews[1].why})`);
const attemptsForDup: PhraseAttempt[] = [{ ...attemptWith(50, 1, 1), songId: 'song1', phraseIndex: 1 }];
const dedup = buildPlan(profile, attemptsForDup, [], [songRec], reviewStates, planNow);
check(dedup.filter((i) => i.songId === 'song1' && i.phraseIndex === 1).length === 1, 'the weakest-phrase item does not duplicate a review item');
const clearTone = exerciseById('clear-tone')!;
const ctPlan = clearTone.build(profile);
check(ctPlan.kind === 'pitched' && ctPlan.analysis.notes.length === 15 && ctPlan.analysis.phrases.length >= 1 && ctPlan.analysis.notes.every((n) => n.midi >= 48 && n.midi <= 72), `Clear tone builds ${ctPlan.kind === 'pitched' ? ctPlan.analysis.notes.length : 0} notes inside the range`);
check(EXERCISES.filter((e) => e.id === 'clear-tone').length === 1 && new Set(EXERCISES.map((e) => e.id)).size === EXERCISES.length, 'exercise ids are unique');
check(exerciseForIssue('breathy')?.id === 'clear-tone' && exerciseForIssue('crack')?.id === 'register-transitions' && exerciseForIssue('out-of-air')?.id === 'breath-support' && exerciseForIssue('strain')?.id === 'sirens', 'exerciseForIssue maps the technique issues');
for (const e of EXERCISES) {
  const p = e.build(profile);
  if (p.kind === 'pitched') check(p.analysis.notes.length > 0 && p.analysis.phrases.length > 0 && p.analysis.duration > 0, `exercise "${e.name}" builds a valid analysis`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
