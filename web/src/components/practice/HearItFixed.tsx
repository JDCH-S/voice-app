import { useEffect, useRef, useState } from 'react';
import type { NoteResult, PitchFrame, SongAnalysis } from '../../lib/types';
import { decodeBlob } from '../../lib/audio/decode';
import { audioBufferToWav, pitchCorrectTake, planCorrections } from '../../lib/audio/pitchCorrect';

/** A take that can be replayed and pitch-corrected. */
export interface TakeForFix {
  id: string;
  label: string; // "phrase 3" | "full run"
  blob: Blob;
  mime: string;
  frames: PitchFrame[];
  noteResults: NoteResult[];
  startSongTime: number;
  tempo: number;
  semitones: number;
  /** playback window in song seconds */
  from: number;
  to: number;
}

export type FixPlayback = 'you' | 'fixed' | 'original';

/** Save a blob through the browser's download prompt. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function safeName(s: string): string {
  return s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'take';
}

/**
 * After a take: "Hear it fixed" renders a pitch-corrected copy of the recording and offers three
 * aligned playback buttons (You, You (fixed), Original singer) plus downloads of the raw take
 * (webm) and the fixed one (wav). Playback itself is done by the practice session so the trail
 * stays on the roll; this component only renders and hands over buffers.
 */
export default function HearItFixed({
  take,
  analysis,
  songTitle,
  hasSinger,
  playing,
  busy,
  onPlay,
  onStop,
}: {
  take: TakeForFix;
  analysis: SongAnalysis;
  songTitle: string;
  /** an isolated vocal or the original mix is available to play as "Original singer" */
  hasSinger: boolean;
  /** which of the three is playing right now (null when nothing) */
  playing: FixPlayback | null;
  /** the session is doing something else (singing, listening) */
  busy: boolean;
  onPlay: (what: FixPlayback, buffer: AudioBuffer | null) => void;
  onStop: () => void;
}) {
  const [state, setState] = useState<{ status: 'idle' | 'rendering' | 'ready' | 'error'; message: string }>({ status: 'idle', message: '' });
  const buffers = useRef<{ you: AudioBuffer; fixed: AudioBuffer; fixedNotes: number } | null>(null);
  const takeId = useRef(take.id);
  const cancelled = useRef(false);

  // a new take resets everything
  useEffect(() => {
    if (takeId.current !== take.id) {
      takeId.current = take.id;
      buffers.current = null;
      setState({ status: 'idle', message: '' });
    }
  }, [take.id]);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  async function render() {
    setState({ status: 'rendering', message: 'Tuning your take…' });
    const id = take.id;
    try {
      const you = await decodeBlob(take.blob);
      const opts = { semitones: take.semitones, startSongTime: take.startSongTime, tempo: take.tempo, noteResults: take.noteResults };
      const regions = planCorrections(take.frames, analysis, opts);
      const fixed = regions.length > 0 ? await pitchCorrectTake(you, take.frames, analysis, opts) : you;
      if (cancelled.current || takeId.current !== id) return;
      buffers.current = { you, fixed, fixedNotes: regions.length };
      setState({
        status: 'ready',
        message:
          regions.length === 0
            ? 'Nothing to fix: every note you sang was within 5 cents of the target.'
            : `${regions.length} ${regions.length === 1 ? 'note' : 'notes'} nudged onto the target pitch. Your timing and tone are untouched, so listen for the difference.`,
      });
    } catch (e) {
      if (cancelled.current || takeId.current !== id) return;
      setState({ status: 'error', message: `Could not decode this take in your browser (${(e as Error).message}).` });
    }
  }

  const b = buffers.current;
  const ext = /ogg/.test(take.mime) ? 'ogg' : /mp4|aac/.test(take.mime) ? 'm4a' : 'webm';
  const base = `${safeName(songTitle)}-${safeName(take.label)}`;

  const playBtn = (what: FixPlayback, label: string, buffer: AudioBuffer | null, disabled = false) => {
    const active = playing === what;
    return (
      <button
        key={what}
        className={`hif-play ${active ? 'active' : ''}`}
        disabled={disabled || (busy && !active)}
        onClick={() => (active ? onStop() : onPlay(what, buffer))}
        aria-pressed={active}
      >
        {active ? '■ ' : '▶ '}
        {label}
      </button>
    );
  };

  return (
    <div className="hif col" style={{ gap: 10 }}>
      {state.status !== 'ready' && (
        <div className="row" style={{ gap: 8 }}>
          <button className="primary hif-render" onClick={render} disabled={state.status === 'rendering' || busy}>
            {state.status === 'rendering' ? 'Tuning…' : '✨ Hear it fixed'}
          </button>
          <button className="small" onClick={() => downloadBlob(take.blob, `${base}.${ext}`)} title="Save your recording to a file">
            Download my take
          </button>
        </div>
      )}
      {state.status === 'idle' && <div className="tiny muted">Hear your own voice with every note pulled onto the right pitch: the fastest way to feel what to aim for.</div>}
      {state.status === 'rendering' && <div className="tiny muted">{state.message}</div>}
      {state.status === 'error' && <div className="tiny" style={{ color: 'var(--bad)' }}>{state.message}</div>}
      {state.status === 'ready' && b && (
        <>
          <div className="small">{state.message}</div>
          <div className="hif-buttons">
            {playBtn('you', 'You', b.you)}
            {playBtn('fixed', 'You (fixed)', b.fixed)}
            {playBtn('original', 'Original singer', null, !hasSinger)}
          </div>
          {!hasSinger && <div className="tiny muted">The original singer is not available for exercises.</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="small" onClick={() => downloadBlob(take.blob, `${base}.${ext}`)}>
              Download my take
            </button>
            <button className="small" onClick={() => downloadBlob(audioBufferToWav(b.fixed), `${base}-fixed.wav`)}>
              Download fixed
            </button>
          </div>
        </>
      )}
    </div>
  );
}
