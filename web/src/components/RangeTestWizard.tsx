import { useEffect, useRef, useState } from 'react';
import { mic, type RawPitch } from '../lib/audio/MicAnalyzer';
import { player } from '../lib/audio/Player';
import { useMicPitch } from '../lib/useMic';
import PitchMeter from './PitchMeter';
import type { RangeTest } from '../lib/types';
import { median, midiToName, nameToMidi, std, voiceTypeFor, mean } from '../lib/music/notes';

type Phase = 'intro' | 'low' | 'high' | 'accuracy' | 'done';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Guided range test: tones step down (then up) one semitone at a time; the singer matches each.
 * Then five match-the-note trials in the comfortable middle of the range.
 */
export default function RangeTestWizard({ onDone }: { onDone: (r: RangeTest) => void }) {
  const [phase, setPhase] = useState<Phase>('intro');
  const { frame } = useMicPitch(phase !== 'intro');
  const [target, setTarget] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [low, setLow] = useState<number | null>(null);
  const [high, setHigh] = useState<number | null>(null);
  const [trial, setTrial] = useState(0);
  const [listening, setListening] = useState(false);
  const buf = useRef<RawPitch[]>([]);
  const stopFlag = useRef(false);
  const [result, setResult] = useState<RangeTest | null>(null);

  useEffect(() => {
    const unsub = mic.subscribe((f) => buf.current.push(f));
    return () => {
      unsub();
      stopFlag.current = true;
    };
  }, []);

  async function listen(seconds: number): Promise<RawPitch[]> {
    buf.current = [];
    setListening(true);
    await sleep(seconds * 1000);
    setListening(false);
    return buf.current.slice();
  }

  /** returns median midi sung, or null when not enough voiced frames */
  function sungMidi(frames: RawPitch[]): number | null {
    const v = frames.filter((f) => f.hz > 0 && f.clarity > 0.6).map((f) => f.midi);
    if (v.length < frames.length * 0.25 || v.length < 8) return null;
    return median(v);
  }

  async function stepTest(start: number, dir: 1 | -1): Promise<number> {
    let m = start;
    let last = start;
    let fails = 0;
    while (!stopFlag.current && m > 36 && m < 96) {
      setTarget(m);
      setMsg(`Sing ${midiToName(m)} on "ah"`);
      await player.tone(m, 1.0, 0.4);
      const fs = await listen(1.8);
      const s = sungMidi(fs);
      let ok = false;
      if (s !== null) {
        let err = s - m;
        // accept an octave slip as a fail (we want the real note)
        ok = Math.abs(err) <= 0.75;
      }
      if (ok) {
        last = m;
        fails = 0;
        m += dir;
      } else {
        fails++;
        if (fails >= 2) break;
        setMsg(`Try ${midiToName(m)} once more`);
      }
    }
    return last;
  }

  async function run() {
    stopFlag.current = false;
    setPhase('low');
    const lowStart = nameToMidi('G3');
    const lo = await stepTest(lowStart, -1);
    setLow(lo);
    if (stopFlag.current) return;
    setPhase('high');
    const highStart = nameToMidi('C4');
    const hi = await stepTest(highStart, 1);
    setHigh(hi);
    if (stopFlag.current) return;
    await runAccuracy(lo, hi);
  }

  async function runAccuracy(lo: number, hi: number) {
    setPhase('accuracy');
    const centre = (lo + hi) / 2;
    const span = Math.max(2, (hi - lo) * 0.3);
    const errors: number[] = [];
    const stabs: number[] = [];
    for (let i = 0; i < 5 && !stopFlag.current; i++) {
      setTrial(i + 1);
      const m = Math.round(centre + (Math.random() * 2 - 1) * span);
      setTarget(m);
      setMsg(`Match ${midiToName(m)} and hold it`);
      await player.tone(m, 1.0, 0.4);
      const fs = await listen(2.0);
      const v = fs.filter((f) => f.hz > 0 && f.clarity > 0.6).map((f) => (f.midi - m) * 100);
      if (v.length >= 8) {
        let e = median(v);
        const oct = Math.round(e / 1200);
        e -= oct * 1200;
        errors.push(Math.abs(e));
        stabs.push(std(v.map((x) => x - oct * 1200)));
      } else {
        errors.push(150);
        stabs.push(100);
      }
    }
    const acc = errors.length ? mean(errors) : 100;
    const stab = stabs.length ? mean(stabs) : 60;
    const score = Math.round(Math.max(0, Math.min(100, 100 - (acc - 10) * 0.8 - Math.max(0, stab - 20) * 0.4)));
    const r: RangeTest = {
      date: Date.now(),
      lowMidi: lo,
      highMidi: hi,
      voiceType: voiceTypeFor(lo, hi),
      accuracyCents: Math.round(acc),
      stabilityCents: Math.round(stab),
      accuracyScore: score,
    };
    setResult(r);
    setPhase('done');
  }

  function stopEarly() {
    stopFlag.current = true;
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      {phase === 'intro' && (
        <>
          <h2>Find your range</h2>
          <p>
            You will hear a note. Sing it back on <b>"ah"</b>. The notes go lower one step at a time until you can't follow, then higher. Stay
            comfortable: never force a note. Then five quick "match the note" trials measure your pitch accuracy.
          </p>
          <button className="primary big" onClick={run}>
            Start the range test
          </button>
        </>
      )}
      {(phase === 'low' || phase === 'high' || phase === 'accuracy') && (
        <div className="grid cols-2">
          <div className="card flat col center">
            <div className="muted">{phase === 'low' ? 'Going down' : phase === 'high' ? 'Going up' : `Accuracy trial ${trial} of 5`}</div>
            <div className="big-note">{target !== null ? midiToName(target) : '–'}</div>
            <div className={`pill ${listening ? 'good' : 'accent'}`}>{listening ? 'Sing now' : 'Listen…'}</div>
            <p className="muted" style={{ marginTop: 10 }}>
              {msg}
            </p>
            {phase !== 'accuracy' && (
              <button onClick={stopEarly} className="ghost small">
                That is my limit, stop here
              </button>
            )}
          </div>
          <div className="card flat">
            <PitchMeter frame={frame} targetMidi={target} />
            <div className="row" style={{ marginTop: 12 }}>
              {low !== null && <span className="pill">Lowest so far: {midiToName(low)}</span>}
              {high !== null && <span className="pill">Highest: {midiToName(high)}</span>}
            </div>
          </div>
        </div>
      )}
      {phase === 'done' && result && (
        <div className="card flat col fade-in">
          <h2>Your voice today</h2>
          <div className="row" style={{ gap: 30 }}>
            <div>
              <div className="tiny muted">Comfortable range</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>
                {midiToName(result.lowMidi)} – {midiToName(result.highMidi)}
              </div>
              <div className="muted small">{result.highMidi - result.lowMidi} semitones</div>
            </div>
            <div>
              <div className="tiny muted">Closest voice type</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{result.voiceType}</div>
              <div className="muted small">by range, a guide not a label</div>
            </div>
            <div>
              <div className="tiny muted">Pitch accuracy</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{result.accuracyScore}/100</div>
              <div className="muted small">
                avg {result.accuracyCents}¢ off, ±{result.stabilityCents}¢ wobble
              </div>
            </div>
          </div>
          <p className="muted">
            {result.accuracyScore >= 80
              ? 'You hear and match notes well. The songs will push you on timing, note length and expression.'
              : result.accuracyScore >= 55
                ? 'You get close to the notes. Daily "Match the note" and slow phrase loops will tighten this quickly.'
                : 'Matching notes is the first skill to build. Start with "Match the note" and sing songs with the guide tone on.'}
          </p>
          <div className="row">
            <button className="primary big" onClick={() => onDone(result)}>
              Save
            </button>
            <button
              onClick={() => {
                setPhase('intro');
                setLow(null);
                setHigh(null);
              }}
            >
              Redo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
