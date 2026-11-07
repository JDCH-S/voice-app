// Pitch-corrected replay ("hear it fixed"): per reference note, the sung region of the take is
// shifted by minus its median cents error so the singer hears their own voice in tune. The output
// keeps the input's exact length and timeline, so it plays in sync with the original.
//
// The DSP core (`planCorrections` + `pitchCorrectChannels`) works on Float32Array channels and a
// sample rate with an injectable pitch shifter, so it runs and is tested in Node. The browser
// entry point `pitchCorrectTake` wraps AudioBuffers and uses the WSOLA stretch + resample path of
// `renderVariant` as the shifter.

import type { NoteResult, PitchFrame, RefNote, SongAnalysis } from '../types';
import { median } from '../music/notes';
import { renderVariant } from './render';

export interface PitchShifter {
  /**
   * Return `channels` transposed by `semitones` (fractional allowed) with the time axis unchanged.
   * The output may differ from the input length by a few tens of milliseconds; the core fits it.
   */
  shift(channels: Float32Array[], sampleRate: number, semitones: number): Promise<Float32Array[]>;
}

export interface PitchCorrectOptions {
  /** Transposition of the reference used for the take (semitones). */
  semitones: number;
  /** Song time at which the recording began (seconds). */
  startSongTime: number;
  /** Playback tempo of the take (1 = original speed). Recording time r = (songTime − startSongTime) / tempo. */
  tempo: number;
  /** Fold errors to the nearest octave before correcting (default true: never jump an octave). */
  allowOctave?: boolean;
  /** Per-note results of the attempt; when given, their cents errors are used instead of recomputing. */
  noteResults?: NoteResult[];
  /** Errors smaller than this are left alone (cents, default 5). */
  minCents?: number;
  /** Crossfade at each join (ms, default 10). */
  crossfadeMs?: number;
  /** Pitch shifter; defaults to the browser's renderVariant engine. */
  shifter?: PitchShifter;
}

/** One region of the recording (seconds on the recording timeline) and the shift to apply. */
export interface CorrectionRegion {
  noteId: number;
  start: number;
  end: number;
  /** Measured error in cents (positive = sharp). The region is shifted by −cents. */
  cents: number;
}

const voiced = (f: PitchFrame) => f.hz > 0 && f.clarity > 0.5 && isFinite(f.midi);

function foldedError(midi: number, target: number, allowOctave: boolean): number {
  const e = midi - target;
  if (!allowOctave) return e;
  return e - 12 * Math.round(e / 12);
}

/**
 * Decide which regions to shift and by how much. Works in song time, returns recording time.
 * Notes that were not sung (too few matching frames) are left untouched, as are unvoiced gaps.
 */
export function planCorrections(frames: PitchFrame[], analysis: SongAnalysis, opts: PitchCorrectOptions): CorrectionRegion[] {
  const allowOctave = opts.allowOctave ?? true;
  const minCents = opts.minCents ?? 5;
  const tempo = opts.tempo > 0 ? opts.tempo : 1;
  const semis = opts.semitones;
  const fs = [...frames].filter((f) => isFinite(f.t)).sort((a, b) => a.t - b.t);
  if (fs.length === 0 || analysis.notes.length === 0) return [];
  const t0 = fs[0].t;
  const t1 = fs[fs.length - 1].t;
  const notes = [...analysis.notes].sort((a, b) => a.start - b.start);
  const resultOf = new Map<number, NoteResult>();
  for (const r of opts.noteResults ?? []) resultOf.set(r.noteId, r);
  const out: CorrectionRegion[] = [];

  const framesIn = (a: number, b: number) => fs.filter((f) => f.t >= a && f.t <= b);
  const matches = (f: PitchFrame, n: RefNote) => voiced(f) && Math.abs(foldedError(f.midi, n.midi + semis + n.cents / 100, allowOctave)) < 2.5;

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.end < t0 - 0.5 || n.start > t1 + 0.5) continue;
    const prev = i > 0 ? notes[i - 1] : null;
    const next = i + 1 < notes.length ? notes[i + 1] : null;
    const dur = n.end - n.start;
    const target = n.midi + semis + n.cents / 100;

    let cents: number | null = null;
    const r = resultOf.get(n.id);
    if (r) {
      if (r.status === 'missed' || r.centsError === null || !isFinite(r.centsError)) continue;
      cents = r.centsError;
    } else {
      const coreA = n.start + Math.min(0.06, dur * 0.25);
      const coreB = n.end - Math.min(0.04, dur * 0.2);
      const core = framesIn(coreA, coreB).filter((f) => matches(f, n));
      if (core.length < 3) continue;
      cents = median(core.map((f) => foldedError(f.midi, target, allowOctave) * 100));
    }
    if (cents === null || Math.abs(cents) < minCents) continue;

    // extend the region over the singer's own voiced span around the note (late entries, long tails),
    // never past the neighbouring notes
    let a = n.start;
    const minA = Math.max(prev ? prev.end : -Infinity, n.start - 0.3);
    for (let k = fs.length - 1; k >= 0; k--) {
      const f = fs[k];
      if (f.t >= n.start) continue;
      if (f.t < minA) break;
      if (!matches(f, n)) break;
      a = f.t;
    }
    let b = n.end;
    const maxB = Math.min(next ? next.start : Infinity, n.end + 0.5);
    for (const f of fs) {
      if (f.t <= n.end) continue;
      if (f.t > maxB) break;
      if (!matches(f, n)) break;
      b = f.t;
    }
    out.push({ noteId: n.id, start: (a - opts.startSongTime) / tempo, end: (b - opts.startSongTime) / tempo, cents });
  }
  return out;
}

/**
 * Apply the regions to raw channels. Output has exactly the input length. Joins are crossfaded
 * over `crossfadeMs`; adjacent regions crossfade into each other, so the original never leaks in
 * between two corrected notes.
 */
export async function pitchCorrectChannels(
  channels: Float32Array[],
  sampleRate: number,
  regionsIn: CorrectionRegion[],
  shifter: PitchShifter,
  crossfadeMs = 10,
): Promise<Float32Array[]> {
  const out = channels.map((c) => Float32Array.from(c));
  if (channels.length === 0) return out;
  const len = channels[0].length;
  const F = Math.max(1, Math.round((sampleRate * crossfadeMs) / 1000));
  const margin = Math.round(sampleRate * 0.08); // extra source so a slightly short shifter output still covers the region
  const minLen = Math.max(2 * F, Math.round(sampleRate * 0.02));

  // sample regions, clipped to the buffer and to each other, in order
  const regions: { a: number; b: number; cents: number }[] = [];
  let lastB = 0;
  for (const r of [...regionsIn].sort((x, y) => x.start - y.start)) {
    let a = Math.max(0, Math.round(r.start * sampleRate), lastB);
    const b = Math.min(len, Math.round(r.end * sampleRate));
    if (a > b) a = b;
    if (b - a < minLen || !isFinite(r.cents) || r.cents === 0) continue;
    regions.push({ a, b, cents: r.cents });
    lastB = b;
  }

  for (const { a, b, cents } of regions) {
    const ea = Math.max(0, a - F);
    const eb = Math.min(len, b + F);
    const srcEnd = Math.min(len, eb + margin);
    const seg = channels.map((c) => c.slice(ea, srcEnd));
    const shifted = await shifter.shift(seg, sampleRate, -cents / 100);
    for (let c = 0; c < out.length; c++) {
      const src = channels[c];
      const dst = out[c];
      const sh = shifted[Math.min(c, shifted.length - 1)];
      for (let i = ea; i < eb; i++) {
        const k = i - ea;
        const v = k < sh.length ? sh[k] : src[i];
        let w = 1;
        if (i < a) w = (k + 1) / (a - ea + 1);
        else if (i >= b) w = (eb - i) / (eb - b + 1);
        dst[i] = dst[i] * (1 - w) + v * w;
      }
    }
  }
  return out;
}

// ---------- browser wrappers ----------

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

function bufferFrom(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate });
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return buf;
}

/** Pitch shifter built on the app's WSOLA stretch + resample renderer (keeps the time axis, tempo 1). */
export function renderVariantShifter(): PitchShifter {
  return {
    async shift(channels, sampleRate, semitones) {
      if (Math.abs(semitones) < 1e-4) return channels.map((c) => Float32Array.from(c));
      const src = bufferFrom(channels, sampleRate);
      const res = await renderVariant(src, 1, semitones, 0, src.length / sampleRate);
      return channelsOf(res).map((c) => Float32Array.from(c));
    },
  };
}

/**
 * Render a pitch-corrected copy of a take. Same length, same sample rate and channel count as the
 * input, so it can be played in sync with the original and the uncorrected take.
 */
export async function pitchCorrectTake(recording: AudioBuffer, frames: PitchFrame[], analysis: SongAnalysis, opts: PitchCorrectOptions): Promise<AudioBuffer> {
  const regions = planCorrections(frames, analysis, opts);
  const shifter = opts.shifter ?? renderVariantShifter();
  const fixed = await pitchCorrectChannels(channelsOf(recording), recording.sampleRate, regions, shifter, opts.crossfadeMs ?? 10);
  return bufferFrom(fixed, recording.sampleRate);
}

/** Encode channels as a 16-bit PCM WAV blob (for "Download fixed"). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const nCh = Math.max(1, channels.length);
  const n = channels[0]?.length ?? 0;
  const bytes = 44 + n * nCh * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nCh * 2, true);
  dv.setUint16(32, nCh * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Convenience: WAV blob of an AudioBuffer. */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  return encodeWav(channelsOf(buffer), buffer.sampleRate);
}
