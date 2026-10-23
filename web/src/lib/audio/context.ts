let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
  }
  return ctx;
}

export async function resumeAudio(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      /* user gesture required */
    }
  }
  return c;
}

export function outputLatencySeconds(): number {
  const c = getAudioContext();
  const out = (c as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
  return (c.baseLatency || 0) + out;
}
