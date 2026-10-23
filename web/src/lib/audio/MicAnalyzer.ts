import { getAudioContext, resumeAudio } from './context';
import { hzToMidi } from '../music/notes';

export interface RawPitch {
  tCtx: number; // AudioContext time at the end of the analysis window
  hz: number;
  midi: number;
  clarity: number;
  rms: number;
  db: number;
  peak: number;
}

type Listener = (p: RawPitch) => void;

/**
 * Opens the microphone, runs the YIN worklet and emits smoothed pitch frames.
 * One instance is shared by the whole app (see useMic).
 */
export class MicAnalyzer {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<Listener>();
  private history: number[] = [];
  private lastVoiced: RawPitch | null = null;
  private workletLoaded = false;
  public deviceLabel: string | null = null;
  public gate = 0.004;
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
      processorOptions: { windowSize: 2048, hop: 512, threshold: 0.15, fmin: 60, fmax: 1200, gate: this.gate },
    });
    this.node.port.onmessage = (e) => this.onFrame(e.data);
    this.source.connect(this.node);
    this.running = true;
  }

  setGate(linearRms: number) {
    this.gate = linearRms;
    this.node?.port.postMessage({ gate: linearRms });
  }

  stop() {
    this.running = false;
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.stream = null;
    this.history = [];
    this.lastVoiced = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  private onFrame(d: { t: number; hz: number; clarity: number; rms: number; peak: number }) {
    let hz = d.hz;
    const clarity = d.clarity;
    if (hz > 0 && clarity > 0.5) {
      // octave-jump guard: if the new estimate is ~2x or ~0.5x the recent stable pitch
      // and the recent frame was confident, fold it back.
      const prev = this.lastVoiced;
      if (prev && getAudioContext().currentTime - prev.tCtx < 0.08) {
        const ratio = hz / prev.hz;
        if (Math.abs(ratio - 2) < 0.06 && prev.clarity > clarity) hz /= 2;
        else if (Math.abs(ratio - 0.5) < 0.015 && prev.clarity > clarity) hz *= 2;
      }
      this.history.push(hz);
      if (this.history.length > 3) this.history.shift();
      const sorted = [...this.history].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      // use the median only to reject single-frame glitches
      if (this.history.length === 3 && Math.abs(1200 * Math.log2(hz / med)) > 300) hz = med;
    } else {
      hz = 0;
      this.history = [];
    }
    const frame: RawPitch = {
      tCtx: d.t,
      hz,
      midi: hz > 0 ? hzToMidi(hz) : NaN,
      clarity,
      rms: d.rms,
      db: d.rms > 0 ? 20 * Math.log10(d.rms) : -100,
      peak: d.peak,
    };
    if (hz > 0) this.lastVoiced = frame;
    this.listeners.forEach((l) => l(frame));
  }
}

export const mic = new MicAnalyzer();
