import type { SongAnalysis } from '../types';
import { toMono, resampleLinear } from '../audio/decode';
import { buildAnalysis } from './segment';

/** Analyse a decoded song entirely in the browser (fallback mode). */
export function analyzeInBrowser(buffer: AudioBuffer, onProgress?: (p: number) => void): Promise<SongAnalysis> {
  return new Promise((resolve, reject) => {
    const sr = 22050;
    const mono = resampleLinear(toMono(buffer), buffer.sampleRate, sr);
    const worker = new Worker(new URL('./melody.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (e) => {
      worker.terminate();
      reject(e.error ?? new Error('Melody worker failed'));
    };
    worker.onmessage = (e) => {
      const d = e.data as { progress?: number; done?: boolean; hz?: Float32Array; rmsDb?: Float32Array; hop?: number; t0?: number };
      if (d.progress !== undefined) onProgress?.(d.progress);
      if (d.done && d.hz && d.rmsDb) {
        worker.terminate();
        const analysis = buildAnalysis(
          { t0: d.t0 ?? 0, hop: d.hop ?? 256 / sr, hz: Array.from(d.hz), rmsDb: Array.from(d.rmsDb) },
          buffer.duration,
          'mix',
          ['Analysed in the browser from the full mix: the melody line may pick up instruments. Run the analysis server for isolated vocals.'],
        );
        resolve(analysis);
      }
    };
    worker.postMessage({ mono, sampleRate: sr }, [mono.buffer]);
  });
}
