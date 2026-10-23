import type { RawPitch } from '../lib/audio/MicAnalyzer';
import { midiToName } from '../lib/music/notes';

/**
 * Shows the sung note and how far it is from the target (or the nearest semitone).
 */
export default function PitchMeter({ frame, targetMidi, tolerance = 50 }: { frame: RawPitch | null; targetMidi?: number | null; tolerance?: number }) {
  const voiced = !!frame && frame.hz > 0 && frame.clarity > 0.5;
  let cents = 0;
  let name = '–';
  if (voiced) {
    const m = frame!.midi;
    const ref = targetMidi ?? Math.round(m);
    cents = (m - ref) * 100;
    if (targetMidi !== undefined && targetMidi !== null) {
      // fold octaves for display
      const oct = Math.round(cents / 1200);
      cents -= oct * 1200;
    }
    name = midiToName(m);
  }
  const clamped = Math.max(-100, Math.min(100, cents));
  const left = 50 + clamped / 2;
  const status = !voiced ? 'none' : Math.abs(cents) <= tolerance ? 'on' : Math.abs(cents) <= tolerance * 2 ? 'near' : 'off';
  const level = frame ? Math.max(0, Math.min(1, (frame.db + 60) / 55)) : 0;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row between">
        <div className="big-note" style={{ fontSize: '2.6rem' }}>
          {name}
        </div>
        <div className={`pill ${status === 'on' ? 'good' : status === 'near' ? 'near' : status === 'off' ? 'bad' : ''}`}>
          {voiced ? `${cents > 0 ? '+' : ''}${Math.round(cents)}¢` : 'silence'}
        </div>
      </div>
      <div className="meter">
        <span className="zero" />
        {voiced && <span className="needle" style={{ left: `${left}%` }} />}
      </div>
      <div className="row between tiny muted">
        <span>flat</span>
        <span>{targetMidi !== undefined && targetMidi !== null ? `target ${midiToName(targetMidi)}` : 'nearest note'}</span>
        <span>sharp</span>
      </div>
      <div className="bar" title="input level">
        <span style={{ width: `${level * 100}%`, background: frame && frame.peak > 0.95 ? 'var(--bad)' : undefined }} />
      </div>
    </div>
  );
}
