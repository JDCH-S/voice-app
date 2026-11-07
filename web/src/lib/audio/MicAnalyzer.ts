import { outputLatencySeconds, resumeAudio } from './context';
import { hzToMidi, median } from '../music/notes';
import { PitchTracker, type Dip, type TrackerInput } from './pitchTrack';
import { DEFAULT_HIGH_MIDI, DEFAULT_REFERENCE_DB, voiceQualityFor } from './voiceQuality';

export interface RawPitch {
  tCtx: number; // AudioContext time at the end of the analysis window
  hz: number;
  midi: number;
  clarity: number;
  rms: number;
  db: number;
  peak: number;
  voicing?: number;
  hnr?: number;
  breathiness?: number;
  pressed?: number;
  centroid?: number;
  tilt?: number;
}

type Listener = (p: RawPitch) => void;

/** One message from the worklet (see public/pitch-worklet.js). */
interface WorkletFrame {
  t: number;
  rms: number;
  peak: number;
  silent: boolean;
  dmin?: number;
  hz?: number[];
  d?: number[];
  bands?: number[];
  centroid?: number;
  onset?: number;
}

interface Input extends TrackerInput {
  rms: number;
  peak: number;
  bands: number[] | null;
  centroid: number;
  dmin: number;
}

export const WORKLET_HOP = 512;
export const WORKLET_WINDOW = 2048;
/** Frames of lookahead in the Viterbi smoother (3 hops ≈ 32 ms at 48 kHz). */
export const TRACKER_LOOKAHEAD = 3;

/**
 * Opens the microphone, runs the YIN/pYIN worklet and emits smoothed pitch frames with voice-quality
 * fields. Each emitted frame carries the context time of its own analysis window, so consumers can
 * map it to song time regardless of the smoother's small lookahead delay.
 * One instance is shared by the whole app (see useMic).
 */
export class MicAnalyzer {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<Listener>();
  private onsetListeners = new Set<(tCtx: number) => void>();
  private tracker = new PitchTracker<Input>({ lookahead: TRACKER_LOOKAHEAD });
  private workletLoaded = false;
  private lowMidi: number | null = null;
  private highMidi: number | null = null;
  private referenceDb: number | null = null;
  public deviceLabel: string | null = null;
  public gate = 0.002; // about -54 dBFS
  public running = false;

  async start(deviceId?: string): Promise<void> {
    if (this.running) return;
    const ctx = await resumeAudio();
    if (!this.workletLoaded) {
      await ctx.audioWorklet.addModule('/pitch-worklet.js');
      this.workletLoaded = true;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    const track = this.stream.getAudioTracks()[0];
    this.deviceLabel = track?.label || null;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'pitch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { windowSize: WORKLET_WINDOW, hop: WORKLET_HOP, fmin: 60, fmax: 1200, gate: this.gate },
    });
    this.tracker.reset();
    this.node.port.onmessage = (e) => this.onMessage(e.data as WorkletFrame);
    this.source.connect(this.node);
    if (this.onsetListeners.size) this.node.port.postMessage({ onsets: true });
    this.running = true;
  }

  setGate(linearRms: number) {
    this.gate = linearRms;
    this.node?.port.postMessage({ gate: linearRms });
  }

  /** The singer's comfortable range (MIDI). `pressed` rises for notes near `highMidi`. */
  setRange(lowMidi: number | null, highMidi: number | null) {
    this.lowMidi = lowMidi;
    this.highMidi = highMidi;
  }

  /** The singer's normal singing level (dBFS, from calibration). `pressed` rises above it. */
  setReferenceLevel(singingLevelDb: number | null) {
    this.referenceDb = singingLevelDb;
  }

  getRange(): { lowMidi: number | null; highMidi: number | null } {
    return { lowMidi: this.lowMidi, highMidi: this.highMidi };
  }

  stop() {
    this.running = false;
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.stream = null;
    this.tracker.reset();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Receive sample-accurate transient onsets (context time) from the worklet while at least one
   * listener is subscribed. Used by the latency measurement.
   */
  subscribeOnsets(fn: (tCtx: number) => void): () => void {
    if (this.onsetListeners.size === 0) this.node?.port.postMessage({ onsets: true });
    this.onsetListeners.add(fn);
    return () => {
      this.onsetListeners.delete(fn);
      if (this.onsetListeners.size === 0) this.node?.port.postMessage({ onsets: false });
    };
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  private onMessage(m: WorkletFrame) {
    if (typeof m.onset === 'number') {
      this.onsetListeners.forEach((l) => l(m.onset as number));
      return;
    }
    const dips: Dip[] = [];
    if (!m.silent && m.hz && m.d) for (let i = 0; i < m.hz.length; i++) dips.push({ hz: m.hz[i], d: m.d[i] });
    const out = this.tracker.push({
      tCtx: m.t,
      silent: !!m.silent,
      dips,
      rms: m.rms,
      peak: m.peak,
      bands: m.bands ?? null,
      centroid: m.centroid ?? 0,
      dmin: m.dmin ?? 1,
    });
    if (!out) return;
    const inp = out.input;
    const hz = out.voiced ? out.hz : 0;
    const db = inp.rms > 0 ? 20 * Math.log10(inp.rms) : -100;
    const midi = hz > 0 ? hzToMidi(hz) : NaN;
    const frame: RawPitch = {
      tCtx: inp.tCtx,
      hz,
      midi,
      clarity: Math.max(0, Math.min(1, 1 - out.d)),
      rms: inp.rms,
      db,
      peak: inp.peak,
      voicing: out.voicing,
    };
    if (!inp.silent && inp.bands) {
      const q = voiceQualityFor(
        { dPrime: out.d, bandsDb: inp.bands, centroid: inp.centroid, db, midi, hz },
        { highMidi: this.highMidi ?? DEFAULT_HIGH_MIDI, referenceDb: this.referenceDb ?? DEFAULT_REFERENCE_DB },
      );
      frame.hnr = q.hnr;
      frame.tilt = q.tilt;
      frame.centroid = q.centroid;
      frame.breathiness = q.breathiness;
      frame.pressed = q.pressed;
    }
    this.listeners.forEach((l) => l(frame));
  }
}

export const mic = new MicAnalyzer();

// ---------------------------------------------------------------------------------------------
// Round-trip latency measurement

export interface LatencyResult {
  latencyMs: number;
  measured: boolean; // false → `latencyMs` is the estimate from the AudioContext
  detected: number; // clicks heard (of `clicks`)
  clicks: number;
  offsetsMs: number[];
  message: string;
}

/** The estimate used when the clicks cannot be heard: output + base latency plus 25 ms for the input path. */
export function estimatedLatencyMs(): number {
  return Math.round(outputLatencySeconds() * 1000 + 25);
}

/** A 2 kHz click with a 1 ms attack: easy to find on the mic's energy envelope. */
function scheduleClick(ctx: AudioContext, at: number, gain = 0.5) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 2000;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 0.001);
  env.gain.setValueAtTime(gain, at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
  osc.connect(env).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.04);
}

/**
 * Plays `clicks` clicks through the speakers at known context times and measures when the
 * microphone hears each (sample-accurate onset detection in the worklet). The median offset is
 * the real round-trip delay between what the singer hears and what the analyser receives.
 * Falls back to the AudioContext estimate when fewer than 3 clicks are detected or the detections
 * disagree. The microphone must be running.
 */
export async function measureLatency(opts: { clicks?: number; spacing?: number; onClick?: (k: number) => void } = {}): Promise<LatencyResult> {
  const clicks = opts.clicks ?? 4;
  const spacing = opts.spacing ?? 0.7;
  const ctx = await resumeAudio();
  const estimate = estimatedLatencyMs();
  if (!mic.running) {
    return { latencyMs: estimate, measured: false, detected: 0, clicks, offsetsMs: [], message: 'The microphone is not running, so the delay was estimated.' };
  }
  const onsets: number[] = [];
  const unsub = mic.subscribeOnsets((t) => onsets.push(t));
  // let the worklet settle its noise floor before the first click
  const t0 = ctx.currentTime + 0.6;
  const times: number[] = [];
  for (let k = 0; k < clicks; k++) {
    const at = t0 + k * spacing;
    times.push(at);
    scheduleClick(ctx, at);
  }
  if (opts.onClick) {
    for (let k = 0; k < clicks; k++) {
      const delay = (times[k] - ctx.currentTime) * 1000;
      setTimeout(() => opts.onClick?.(k), Math.max(0, delay));
    }
  }
  const end = times[clicks - 1] + 0.6;
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if (ctx.currentTime >= end) {
        clearInterval(iv);
        resolve();
      }
    }, 30);
  });
  unsub();
  return latencyFromOnsets(times, onsets, estimate);
}

/**
 * Pure decision step of the latency measurement: match each click time with the first onset
 * 2..500 ms after it, then take the median. Falls back to `estimateMs` (and says why) when fewer
 * than 3 clicks were heard or the offsets disagree by more than 25 ms (median absolute deviation).
 */
export function latencyFromOnsets(clickTimes: number[], onsets: number[], estimateMs: number): LatencyResult {
  const clicks = clickTimes.length;
  const offsets: number[] = [];
  for (const at of clickTimes) {
    const hit = onsets.find((o) => o - at >= 0.002 && o - at <= 0.5);
    if (hit !== undefined) offsets.push((hit - at) * 1000);
  }
  const detected = offsets.length;
  const rounded = offsets.map((o) => Math.round(o));
  if (detected < 3) {
    return {
      latencyMs: estimateMs,
      measured: false,
      detected,
      clicks,
      offsetsMs: rounded,
      message:
        detected === 0
          ? `The microphone did not hear the clicks (headphones still on?). Using the estimate of ${estimateMs} ms.`
          : `Only ${detected} of ${clicks} clicks were heard, not enough to trust. Using the estimate of ${estimateMs} ms.`,
    };
  }
  const med = median(offsets);
  const spread = median(offsets.map((o) => Math.abs(o - med)));
  if (spread > 25) {
    return {
      latencyMs: estimateMs,
      measured: false,
      detected,
      clicks,
      offsetsMs: rounded,
      message: `The clicks were heard at inconsistent times (±${Math.round(spread)} ms), probably other noise. Using the estimate of ${estimateMs} ms.`,
    };
  }
  const latencyMs = Math.round(med);
  return {
    latencyMs,
    measured: true,
    detected,
    clicks,
    offsetsMs: rounded,
    message: `Measured ${latencyMs} ms between playing a sound and hearing it in the microphone (${detected} of ${clicks} clicks).`,
  };
}
