import { getAudioContext, resumeAudio } from './context';
import { renderVariant } from './render';
import { midiToHz } from '../music/notes';

export type TrackKind = 'original' | 'vocals' | 'instrumental';

export interface GuideNote {
  start: number;
  end: number;
  midi: number;
}

export interface PlayOptions {
  from: number; // song seconds
  to: number;
  loop: boolean;
  tempo: number; // 1 = original
  semitones: number;
  gains: Partial<Record<TrackKind, number>>;
  guideNotes?: GuideNote[];
  guideGain?: number;
  /** A user recording to play along (replay mode). Starts at `recordingStart` song time, recorded at `recordingTempo`. */
  recording?: { buffer: AudioBuffer; start: number; tempo: number; gain: number };
  onEnded?: () => void;
  onLoop?: (iteration: number) => void;
}

interface Variant {
  key: string;
  buffer: AudioBuffer;
  start: number;
  end: number;
}

type Listener = () => void;

/**
 * Plays the song tracks with optional tempo change, transposition, looping and guide tones.
 * All timing is expressed in "song seconds" of the original recording.
 */
export class Player {
  private tracks = new Map<TrackKind, AudioBuffer>();
  private variants = new Map<string, Variant>();
  private sources: AudioScheduledSourceNode[] = [];
  private guideNodes: AudioScheduledSourceNode[] = [];
  private master: GainNode;
  private startCtx = 0;
  private opts: PlayOptions | null = null;
  private loopTimer: number | null = null;
  private endTimer: number | null = null;
  private iteration = 0;
  private listeners = new Set<Listener>();
  public playing = false;
  public preparing = false;

  constructor() {
    const ctx = getAudioContext();
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);
  }

  setTrack(kind: TrackKind, buffer: AudioBuffer | null) {
    if (buffer) this.tracks.set(kind, buffer);
    else this.tracks.delete(kind);
    for (const k of [...this.variants.keys()]) if (k.startsWith(kind + '|')) this.variants.delete(k);
  }

  hasTrack(kind: TrackKind): boolean {
    return this.tracks.has(kind);
  }

  clear() {
    this.stop();
    this.tracks.clear();
    this.variants.clear();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private variantKey(kind: TrackKind, tempo: number, semis: number, start: number, end: number) {
    return `${kind}|${tempo.toFixed(3)}|${semis}|${start.toFixed(2)}|${end.toFixed(2)}`;
  }

  /** Pre-render the variants needed for the given options. Cheap when tempo=1 and semitones=0. */
  async prepare(kinds: TrackKind[], tempo: number, semitones: number, start: number, end: number): Promise<void> {
    const needed = kinds.filter((k) => this.tracks.has(k));
    const identity = Math.abs(tempo - 1) < 1e-6 && semitones === 0;
    if (identity) return;
    this.preparing = true;
    this.emit();
    try {
      // render a little extra margin so pre-roll and loop tails exist
      const s = Math.max(0, start - 1.5);
      const e = end + 1.5;
      for (const kind of needed) {
        const key = this.variantKey(kind, tempo, semitones, s, e);
        if (this.variants.has(key)) continue;
        const buf = await renderVariant(this.tracks.get(kind)!, tempo, semitones, s, e);
        // keep memory bounded: at most 6 variants per track kind
        const keys = [...this.variants.keys()].filter((k) => k.startsWith(kind + '|'));
        if (keys.length >= 6) this.variants.delete(keys[0]);
        this.variants.set(key, { key, buffer: buf, start: s, end: e });
      }
    } finally {
      this.preparing = false;
      this.emit();
    }
  }

  private findVariant(kind: TrackKind, tempo: number, semis: number, from: number, to: number): Variant | null {
    for (const v of this.variants.values()) {
      if (!v.key.startsWith(kind + '|')) continue;
      const [, t, s] = v.key.split('|');
      if (Math.abs(parseFloat(t) - tempo) > 1e-3 || parseInt(s, 10) !== semis) continue;
      if (v.start <= from + 1e-3 && v.end >= to - 1e-3) return v;
    }
    return null;
  }

  async play(opts: PlayOptions): Promise<void> {
    this.stop();
    const ctx = await resumeAudio();
    this.opts = opts;
    const { from, to, tempo, semitones, loop } = opts;
    const identity = Math.abs(tempo - 1) < 1e-6 && semitones === 0;
    const kinds = (Object.keys(opts.gains) as TrackKind[]).filter((k) => (opts.gains[k] ?? 0) > 0 && this.tracks.has(k));
    if (!identity) await this.prepare(kinds, tempo, semitones, from, to);
    const startAt = ctx.currentTime + 0.08;
    this.startCtx = startAt;
    this.iteration = 0;
    const segLen = (to - from) / tempo;
    for (const kind of kinds) {
      const gainNode = ctx.createGain();
      gainNode.gain.value = opts.gains[kind] ?? 1;
      gainNode.connect(this.master);
      const src = ctx.createBufferSource();
      let offset: number;
      let loopStart: number;
      let loopEnd: number;
      if (identity) {
        src.buffer = this.tracks.get(kind)!;
        offset = from;
        loopStart = from;
        loopEnd = to;
      } else {
        const v = this.findVariant(kind, tempo, semitones, from, to);
        if (!v) continue;
        src.buffer = v.buffer;
        offset = (from - v.start) / tempo;
        loopStart = offset;
        loopEnd = (to - v.start) / tempo;
      }
      src.loop = loop;
      if (loop) {
        src.loopStart = loopStart;
        src.loopEnd = loopEnd;
      }
      src.connect(gainNode);
      src.start(startAt, offset, loop ? undefined : Math.max(0.01, loopEnd - offset));
      this.sources.push(src);
    }
    if (opts.recording) {
      const r = opts.recording;
      const g = ctx.createGain();
      g.gain.value = r.gain;
      g.connect(this.master);
      const src = ctx.createBufferSource();
      src.buffer = r.buffer;
      // recording time r = (songTime - r.start) / r.tempo
      const recOffset = (from - r.start) / r.tempo;
      const when = recOffset >= 0 ? startAt : startAt - recOffset * (r.tempo / tempo);
      src.playbackRate.value = r.tempo / tempo;
      src.connect(g);
      src.start(when, Math.max(0, recOffset));
      this.sources.push(src);
    }
    this.scheduleGuide(startAt);
    this.playing = true;
    this.emit();
    if (loop) {
      const tick = () => {
        if (!this.playing) return;
        const elapsed = ctx.currentTime - this.startCtx;
        const it = Math.floor(elapsed / segLen);
        if (it > this.iteration) {
          this.iteration = it;
          this.scheduleGuide(this.startCtx + it * segLen);
          opts.onLoop?.(it);
        }
        // schedule guide for the next iteration slightly ahead
        const next = this.startCtx + (it + 1) * segLen;
        if (next - ctx.currentTime < 0.25 && this.lastGuideIteration < it + 1) {
          this.scheduleGuide(next);
          this.lastGuideIteration = it + 1;
        }
        this.loopTimer = window.setTimeout(tick, 50);
      };
      this.loopTimer = window.setTimeout(tick, 50);
    } else {
      this.endTimer = window.setTimeout(
        () => {
          if (!this.playing) return;
          this.stop();
          opts.onEnded?.();
        },
        (startAt - ctx.currentTime + segLen) * 1000 + 30,
      );
    }
  }

  private lastGuideIteration = 0;

  private scheduleGuide(iterationStartCtx: number) {
    const opts = this.opts;
    if (!opts || !opts.guideNotes || opts.guideNotes.length === 0) return;
    const ctx = getAudioContext();
    const g = opts.guideGain ?? 0.35;
    const { from, to, tempo, semitones } = opts;
    for (const n of opts.guideNotes) {
      if (n.end <= from || n.start >= to) continue;
      const s = Math.max(n.start, from);
      const e = Math.min(n.end, to);
      const t0 = iterationStartCtx + (s - from) / tempo;
      const t1 = iterationStartCtx + (e - from) / tempo;
      if (t1 <= ctx.currentTime) continue;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(n.midi + semitones);
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = midiToHz(n.midi + semitones) * 2;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, Math.max(ctx.currentTime, t0));
      env.gain.linearRampToValueAtTime(g, Math.max(ctx.currentTime, t0) + 0.02);
      env.gain.setValueAtTime(g, Math.max(t1 - 0.05, t0 + 0.03));
      env.gain.linearRampToValueAtTime(0, t1);
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      osc.connect(env);
      osc2.connect(g2).connect(env);
      env.connect(this.master);
      osc.start(Math.max(ctx.currentTime, t0));
      osc2.start(Math.max(ctx.currentTime, t0));
      osc.stop(t1 + 0.01);
      osc2.stop(t1 + 0.01);
      this.guideNodes.push(osc, osc2);
    }
  }

  stop() {
    if (this.loopTimer) window.clearTimeout(this.loopTimer);
    if (this.endTimer) window.clearTimeout(this.endTimer);
    this.loopTimer = null;
    this.endTimer = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    for (const s of this.guideNodes) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources = [];
    this.guideNodes = [];
    const was = this.playing;
    this.playing = false;
    this.lastGuideIteration = 0;
    if (was) this.emit();
  }

  /** Current song time, or null when stopped. */
  position(): number | null {
    if (!this.playing || !this.opts) return null;
    const ctx = getAudioContext();
    const { from, to, tempo, loop } = this.opts;
    let elapsed = (ctx.currentTime - this.startCtx) * tempo;
    if (elapsed < 0) elapsed = 0;
    const len = to - from;
    if (loop && len > 0) elapsed = elapsed % len;
    return from + Math.min(elapsed, len);
  }

  /** Convert an AudioContext timestamp into song time for the current playback. */
  songTimeAt(ctxTime: number): number | null {
    if (!this.playing || !this.opts) return null;
    const { from, to, tempo, loop } = this.opts;
    let elapsed = (ctxTime - this.startCtx) * tempo;
    const len = to - from;
    if (loop && len > 0) elapsed = ((elapsed % len) + len) % len;
    return from + elapsed;
  }

  currentIteration(): number {
    return this.iteration;
  }

  setMasterGain(v: number) {
    this.master.gain.value = v;
  }

  /** Play a single tone (used by onboarding and exercises). Returns when finished. */
  async tone(midi: number, seconds: number, gain = 0.4): Promise<void> {
    const ctx = await resumeAudio();
    const t0 = ctx.currentTime + 0.03;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToHz(midi);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.03);
    env.gain.setValueAtTime(gain, t0 + seconds - 0.08);
    env.gain.linearRampToValueAtTime(0, t0 + seconds);
    osc.connect(env).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + seconds + 0.02);
    this.guideNodes.push(osc);
    await new Promise((r) => setTimeout(r, seconds * 1000 + 60));
  }
}

export const player = new Player();
