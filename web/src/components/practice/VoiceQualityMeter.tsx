import { useEffect, useRef, useState } from 'react';
import type { RawPitch } from '../../lib/audio/MicAnalyzer';

/** Thresholds agreed with the audio-core engineers: a plain sawtooth reads pressed ≈ 0.33, relaxed voices ≈ 0. */
export const BREATHY_AMBER = 0.4;
export const BREATHY_RED = 0.6;
export const PRESSED_AMBER = 0.4;
export const PRESSED_RED = 0.7;
/** How long a value has to stay in the red before the hint appears (ms). */
export const HINT_AFTER_MS = 1000;
/** How long the hint stays after the value leaves the red (ms). */
const HINT_LINGER_MS = 3500;

type Zone = 'green' | 'amber' | 'red' | 'none';

export function breathyZone(v: number | null): Zone {
  if (v === null || !isFinite(v)) return 'none';
  return v > BREATHY_RED ? 'red' : v >= BREATHY_AMBER ? 'amber' : 'green';
}

export function pressedZone(v: number | null): Zone {
  if (v === null || !isFinite(v)) return 'none';
  return v > PRESSED_RED ? 'red' : v >= PRESSED_AMBER ? 'amber' : 'green';
}

const ZONE_COLOR: Record<Zone, string> = { green: 'var(--good)', amber: 'var(--near)', red: 'var(--bad)', none: 'var(--line)' };

interface Smoothed {
  breathy: number | null;
  pressed: number | null;
  measured: boolean; // did any frame carry the fields at all
}

/**
 * Two small live bars next to the pitch meter: "airy ↔ clear" (breathiness) and
 * "relaxed ↔ pushed" (pressed). Values are lightly smoothed over voiced frames; when the singer
 * is silent the last reading is kept but greyed. A plain-words hint appears when a bar has been in
 * the red for more than a second.
 */
export default function VoiceQualityMeter({ frame, compact }: { frame: RawPitch | null; compact?: boolean }) {
  const voiced = !!frame && frame.hz > 0 && frame.clarity > 0.5;
  const sm = useRef<Smoothed>({ breathy: null, pressed: null, measured: false });
  const redSince = useRef<{ breathy: number | null; pressed: number | null }>({ breathy: null, pressed: null });
  const lastRed = useRef<{ breathy: number; pressed: number }>({ breathy: -Infinity, pressed: -Infinity });
  const [hint, setHint] = useState<{ kind: 'breathy' | 'pressed'; text: string } | null>(null);

  if (frame && (typeof frame.breathiness === 'number' || typeof frame.pressed === 'number')) sm.current.measured = true;
  if (voiced && frame) {
    const a = 0.25;
    if (typeof frame.breathiness === 'number' && isFinite(frame.breathiness)) {
      const prev = sm.current.breathy;
      sm.current.breathy = prev === null ? frame.breathiness : prev + a * (frame.breathiness - prev);
    }
    if (typeof frame.pressed === 'number' && isFinite(frame.pressed)) {
      const prev = sm.current.pressed;
      sm.current.pressed = prev === null ? frame.pressed : prev + a * (frame.pressed - prev);
    }
  }
  const breathy = sm.current.breathy;
  const pressed = sm.current.pressed;
  const bz = voiced ? breathyZone(breathy) : 'none';
  const pz = voiced ? pressedZone(pressed) : 'none';

  // red-for-more-than-a-second detection (runs on every frame update)
  useEffect(() => {
    const now = performance.now();
    const rs = redSince.current;
    const lr = lastRed.current;
    for (const k of ['breathy', 'pressed'] as const) {
      const z = k === 'breathy' ? bz : pz;
      if (z === 'red') {
        if (rs[k] === null) rs[k] = now;
        lr[k] = now;
      } else rs[k] = null;
    }
    let next: { kind: 'breathy' | 'pressed'; text: string } | null = null;
    if (rs.pressed !== null && now - rs.pressed > HINT_AFTER_MS) {
      next = { kind: 'pressed', text: 'That sounds pushed. Drop the shoulders, let the jaw hang loose and sing it softer; a lower key is fine.' };
    } else if (rs.breathy !== null && now - rs.breathy > HINT_AFTER_MS) {
      next = { kind: 'breathy', text: 'Lots of air is escaping. Bring the vocal folds together gently, like a soft "uh-oh", and sing on a thinner stream of air.' };
    }
    if (next) setHint((h) => (h && h.kind === next!.kind ? h : next));
    else setHint((h) => (h && now - lr[h.kind] < HINT_LINGER_MS ? h : null));
  }, [frame, bz, pz]);

  if (frame && !sm.current.measured) {
    return (
      <div className="vq tiny muted" title="This browser's audio engine does not report breathiness or strain">
        Voice quality: not measured in this browser.
      </div>
    );
  }

  const pct = (v: number | null) => `${Math.round(Math.max(0, Math.min(1, v ?? 0)) * 100)}%`;
  return (
    <div className={`vq col ${compact ? 'compact' : ''}`} style={{ gap: 6 }}>
      <div className="vq-row" data-zone={bz}>
        <span className="vq-label">airy</span>
        <div className="vq-bar" title={breathy === null ? 'waiting for your voice' : `breathiness ${pct(breathy)}`}>
          <span className="vq-fill" style={{ width: pct(breathy === null ? 0 : 1 - breathy), background: ZONE_COLOR[bz], opacity: voiced ? 1 : 0.4 }} />
          <i className="vq-mark" style={{ left: `${(1 - BREATHY_RED) * 100}%` }} />
          <i className="vq-mark" style={{ left: `${(1 - BREATHY_AMBER) * 100}%` }} />
        </div>
        <span className="vq-label">clear</span>
      </div>
      <div className="vq-row" data-zone={pz}>
        <span className="vq-label">relaxed</span>
        <div className="vq-bar" title={pressed === null ? 'waiting for your voice' : `pressed ${pct(pressed)}`}>
          <span className="vq-fill" style={{ width: pct(pressed), background: ZONE_COLOR[pz], opacity: voiced ? 1 : 0.4 }} />
          <i className="vq-mark" style={{ left: `${PRESSED_AMBER * 100}%` }} />
          <i className="vq-mark" style={{ left: `${PRESSED_RED * 100}%` }} />
        </div>
        <span className="vq-label">pushed</span>
      </div>
      {hint && (
        <div className={`vq-hint tiny ${hint.kind}`} role="status">
          {hint.text}
        </div>
      )}
    </div>
  );
}
