import { getAudioContext } from './context';

export async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  const ab = await blob.arrayBuffer();
  return await ctx.decodeAudioData(ab.slice(0));
}

export function toMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  const chs = buffer.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chs;
  }
  return out;
}

/** Linear-interpolation resampler for analysis (not for playback). */
export function resampleLinear(x: Float32Array, srIn: number, srOut: number): Float32Array {
  if (srIn === srOut) return x;
  const ratio = srIn / srOut;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = x[i0] ?? 0;
    const b = x[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, bytes - 8, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * 2, true);
  v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, len * numCh * 2, true);
  let o = 44;
  const chans = Array.from({ length: numCh }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
