import { useEffect, useRef, useState } from 'react';
import { mic, type RawPitch } from './audio/MicAnalyzer';

/** Subscribe to the shared microphone analyser. Returns the latest frame (throttled to animation frames). */
export function useMicPitch(active = true): { frame: RawPitch | null; error: string | null; ready: boolean } {
  const [frame, setFrame] = useState<RawPitch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(mic.running);
  const latest = useRef<RawPitch | null>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let cancelled = false;
    const unsub = mic.subscribe((f) => {
      latest.current = f;
    });
    const loop = () => {
      if (latest.current) setFrame(latest.current);
      raf = requestAnimationFrame(loop);
    };
    mic
      .start()
      .then(() => {
        if (cancelled) return;
        setReady(true);
        raf = requestAnimationFrame(loop);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || 'Microphone access was refused');
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [active]);
  return { frame, error, ready };
}
