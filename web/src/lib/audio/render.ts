import { getAudioContext } from './context';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (chs: Float32Array[]) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[] }>) => {
      const cb = pending.get(e.data.id);
      if (cb) {
        pending.delete(e.data.id);
        cb(e.data.channels);
      }
    };
  }
  return worker;
}

function stretchChannels(channels: Float32Array[], sampleRate: number, factor: number): Promise<Float32Array[]> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const copies = channels.map((c) => new Float32Array(c));
    getWorker().postMessage({ id, channels: copies, sampleRate, factor }, copies.map((c) => c.buffer));
  });
}

function slice(buffer: AudioBuffer, start: number, end: number): Float32Array[] {
  const sr = buffer.sampleRate;
  const s = Math.max(0, Math.floor(start * sr));
  const e = Math.min(buffer.length, Math.ceil(end * sr));
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c).slice(s, e));
  return out;
}

async function resample(channels: Float32Array[], sampleRate: number, rate: number): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  const src = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((c, i) => src.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  if (Math.abs(rate - 1) < 1e-6) return src;
  const outLen = Math.max(1, Math.floor(channels[0].length / rate));
  const off = new OfflineAudioContext(channels.length, outLen, sampleRate);
  const node = off.createBufferSource();
  node.buffer = src;
  node.playbackRate.value = rate;
  node.connect(off.destination);
  node.start(0);
  return await off.startRendering();
}

/**
 * Render a region of `buffer` at a new tempo (0.25..2, 1 = original speed) and transposition
 * (semitones), preserving pitch when slowing down. Returns an AudioBuffer whose time axis is
 * (song time − start) / tempo.
 */
export async function renderVariant(
  buffer: AudioBuffer,
  tempo: number,
  semitones: number,
  start: number,
  end: number,
): Promise<AudioBuffer> {
  const chans = slice(buffer, start, end);
  const rate = Math.pow(2, semitones / 12);
  const stretch = rate / tempo; // length multiplier before resampling
  let stretched = chans;
  if (Math.abs(stretch - 1) > 1e-3) {
    stretched = await stretchChannels(chans, buffer.sampleRate, stretch);
  }
  return await resample(stretched, buffer.sampleRate, rate);
}
