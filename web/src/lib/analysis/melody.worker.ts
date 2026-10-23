/// <reference lib="webworker" />
import { extractMelody } from './melodyExtract';

self.onmessage = (e: MessageEvent<{ mono: Float32Array; sampleRate: number }>) => {
  const { mono, sampleRate } = e.data;
  const r = extractMelody(mono, sampleRate, (p) => (self as unknown as Worker).postMessage({ progress: p }));
  (self as unknown as Worker).postMessage({ done: true, ...r }, [r.hz.buffer, r.rmsDb.buffer, r.clarity.buffer]);
};
