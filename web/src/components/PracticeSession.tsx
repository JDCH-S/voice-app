import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CriterionScore, Level, NoteIssue, NoteResult, PitchFrame, SongAnalysis, Tip } from '../lib/types';
import { player, type TrackKind } from '../lib/audio/Player';
import { mic, type RawPitch } from '../lib/audio/MicAnalyzer';
import { useMicPitch } from '../lib/useMic';
import { scorePhrase, type PhraseScore } from '../lib/scoring/score';
import PianoRoll from './PianoRoll';
import PitchMeter from './PitchMeter';
import FeedbackPanel from './FeedbackPanel';
import ScoreRing from './ScoreRing';
import { fmtTime, midiToName, transposeKey, keyName } from '../lib/music/notes';
import { exerciseForTags } from '../lib/exercises/library';
import { Link } from 'react-router-dom';

export type Backing = 'original' | 'vocals' | 'instrumental' | 'instrumental+guide' | 'original+guide' | 'guide';

export interface AttemptOut {
  kind: 'phrase' | 'full';
  phraseIndex: number | null;
  score: PhraseScore;
  frames: PitchFrame[];
  tempo: number;
  semitones: number;
  startSongTime: number;
  perPhrase?: { phraseIndex: number; score: PhraseScore }[];
  recording?: { blob: Blob; mime: string } | null;
}

export interface PracticeSessionProps {
  analysis: SongAnalysis;
  title: string;
  subtitle?: string;
  hasStems: boolean;
  hasOriginal: boolean;
  level: Level;
  allowOctave: boolean;
  semitones: number;
  onSemitones?: (k: number) => void;
  recommendedSemitones?: number;
  recommendReason?: string;
  latencyMs: number;
  highMidi?: number | null;
  onAttempt: (a: AttemptOut) => void | Promise<void>;
  onActivity?: (seconds: number) => void;
  exercise?: { cue: string; guideGain: number } | null;
  initialPhrase?: number;
  banner?: React.ReactNode;
  /** a previously saved take to replay: decoded buffer + metadata */
  replayRequest?: { buffer: AudioBuffer; start: number; tempo: number; semitones: number; frames: PitchFrame[]; from: number; to: number } | null;
  onReplayDone?: () => void;
}

type Step = 'idle' | 'listening' | 'singing' | 'review' | 'replaying' | 'fullrun';

const TEMPOS = [1, 0.85, 0.7, 0.5];
const PREROLL = 1.2;

export default function PracticeSession(props: PracticeSessionProps) {
  const { analysis, level, allowOctave, semitones, hasStems, hasOriginal, exercise } = props;
  const phrases = analysis.phrases;
  const [phraseIndex, setPhraseIndex] = useState(Math.min(props.initialPhrase ?? 0, Math.max(0, phrases.length - 1)));
  const [tempo, setTempo] = useState(1);
  const [loop, setLoop] = useState(false);
  const [mode, setMode] = useState<'phrase' | 'full'>('phrase');
  const defaultBacking: Backing = exercise ? 'guide' : hasStems ? 'instrumental+guide' : hasOriginal ? 'original+guide' : 'guide';
  const [backing, setBacking] = useState<Backing>(defaultBacking);
  const [step, setStep] = useState<Step>('idle');
  const [preparing, setPreparing] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [feedback, setFeedback] = useState<{ scores: CriterionScore; issues: NoteIssue[]; tip: Tip; results: Map<number, NoteResult>; title: string } | null>(null);
  const [fullResult, setFullResult] = useState<{ overall: number; perPhrase: { phraseIndex: number; score: PhraseScore }[] } | null>(null);
  const [leakWarn, setLeakWarn] = useState(false);
  const [strainWarn, setStrainWarn] = useState(false);
  const [iteration, setIteration] = useState(0);
  const { frame } = useMicPitch(true);

  const framesRef = useRef<PitchFrame[]>([]); // frames drawn on the roll (current iteration / take)
  const stepRef = useRef<Step>('idle');
  stepRef.current = step;
  const lastTRef = useRef<number>(-1);
  const iterStartRef = useRef<number>(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const strainCount = useRef(0);
  const leakCount = useRef({ hit: 0, total: 0 });
  const guideNotesRef = useRef<{ start: number; end: number; midi: number }[]>([]);
  const takeStartRef = useRef<number>(0);
  const latency = props.latencyMs / 1000;

  const phrase = phrases[phraseIndex] ?? null;
  const phraseNotes = useMemo(() => (phrase ? phrase.noteIds.map((id) => analysis.notes[id]) : []), [phrase, analysis]);
  const guideNotes = useMemo(() => analysis.notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi })), [analysis]);
  guideNotesRef.current = guideNotes;

  useEffect(() => {
    const unsub = player.subscribe(() => setPreparing(player.preparing));
    return () => {
      unsub();
      player.stop();
    };
  }, []);

  // reset when phrase changes
  useEffect(() => {
    player.stop();
    setStep('idle');
    setFeedback(null);
    framesRef.current = [];
    setIteration(0);
  }, [phraseIndex, semitones]);

  const gainsFor = useCallback(
    (b: Backing, forListen: boolean): { gains: Partial<Record<TrackKind, number>>; guide: boolean } => {
      if (forListen) {
        if (hasStems) return { gains: { vocals: 0.9 }, guide: true };
        if (hasOriginal) return { gains: { original: 0.45 }, guide: true };
        return { gains: {}, guide: true };
      }
      switch (b) {
        case 'original':
          return { gains: { original: 1 }, guide: false };
        case 'original+guide':
          return { gains: { original: 0.8 }, guide: true };
        case 'vocals':
          return { gains: { vocals: 1 }, guide: false };
        case 'instrumental':
          return { gains: { instrumental: 1 }, guide: false };
        case 'instrumental+guide':
          return { gains: { instrumental: 0.9 }, guide: true };
        default:
          return { gains: {}, guide: true };
      }
    },
    [hasStems, hasOriginal],
  );

  // ---- microphone frames → song time, live drawing, loop detection ----
  useEffect(() => {
    const unsub = mic.subscribe((f: RawPitch) => {
      const st = stepRef.current;
      if (st !== 'singing' && st !== 'listening' && st !== 'fullrun') return;
      const t = player.songTimeAt(f.tCtx - latency);
      if (t === null) return;
      if (st === 'listening') {
        // headphone leak check: does the mic hear the guide tone?
        leakCount.current.total++;
        if (f.hz > 0 && f.clarity > 0.85) {
          const n = guideNotesRef.current.find((g) => t >= g.start && t <= g.end);
          if (n) {
            const err = Math.abs(((f.midi - (n.midi + semitones) + 6) % 12) - 6);
            if (err < 0.4) leakCount.current.hit++;
          }
        }
        return;
      }
      const pf: PitchFrame = { t, hz: f.hz, midi: f.midi, rms: f.rms, db: f.db, clarity: f.clarity };
      // loop wrap: time jumped backwards → finish previous iteration
      if (st === 'singing' && lastTRef.current >= 0 && t < lastTRef.current - 1.0) {
        finishIteration(framesRef.current);
        framesRef.current = [];
        iterStartRef.current = performance.now();
        setIteration((i) => i + 1);
      }
      lastTRef.current = t;
      framesRef.current.push(pf);
      // strain heuristic: pushed, clipping high notes
      if (props.highMidi && f.hz > 0 && f.midi >= props.highMidi - 1 && f.peak > 0.95) {
        strainCount.current++;
        if (strainCount.current > 12) setStrainWarn(true);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latency, semitones, phraseIndex, tempo, level, allowOctave]);

  const finishIteration = useCallback(
    (frames: PitchFrame[]) => {
      if (!phrase) return;
      // need to have covered at least half of the phrase in time
      const covered = frames.length ? frames[frames.length - 1].t - Math.max(frames[0].t, phrase.start) : 0;
      if (covered < (phrase.end - phrase.start) * 0.5) return;
      const sc = scorePhrase(analysis, phrase, frames, { semitones, level, allowOctave });
      const results = new Map(sc.noteResults.map((r) => [r.noteId, r]));
      setFeedback({ scores: sc.scores, issues: sc.issues, tip: sc.tip, results, title: `phrase ${phraseIndex + 1}` });
      props.onActivity?.((phrase.end - phrase.start) / tempo);
      props.onAttempt({
        kind: 'phrase',
        phraseIndex,
        score: sc,
        frames: frames.slice(),
        tempo,
        semitones,
        startSongTime: takeStartRef.current,
        recording: null,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phrase, analysis, semitones, level, allowOctave, tempo, phraseIndex],
  );

  // ---- actions ----
  async function listen() {
    if (!phrase) return;
    player.stop();
    setFeedback(null);
    framesRef.current = [];
    leakCount.current = { hit: 0, total: 0 };
    setLeakWarn(false);
    const { gains } = gainsFor(backing, true);
    const from = Math.max(0, phrase.start - 0.3);
    const to = phrase.end + 0.3;
    setStep('listening');
    setStatus('Listen: these are the notes to aim for.');
    await player.play({
      from,
      to,
      loop: false,
      tempo,
      semitones,
      gains,
      guideNotes: guideNotes,
      guideGain: exercise?.guideGain ?? 0.45,
      onEnded: () => {
        const lc = leakCount.current;
        if (lc.total > 20 && lc.hit / lc.total > 0.3) setLeakWarn(true);
        setStep('idle');
        setStatus('Now sing it.');
      },
    });
  }

  function startRecorder() {
    const stream = mic.getStream();
    if (!stream || typeof MediaRecorder === 'undefined') return;
    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.start(250);
      recorderRef.current = rec;
    } catch {
      recorderRef.current = null;
    }
  }

  function stopRecorder(): Promise<{ blob: Blob; mime: string } | null> {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const mime = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        resolve(blob.size > 0 ? { blob, mime } : null);
      };
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
  }

  async function sing() {
    if (!phrase) return;
    player.stop();
    setFeedback(null);
    framesRef.current = [];
    lastTRef.current = -1;
    strainCount.current = 0;
    setStrainWarn(false);
    setIteration(0);
    const { gains, guide } = gainsFor(backing, false);
    const from = Math.max(0, phrase.start - PREROLL);
    const to = phrase.end + 0.4;
    takeStartRef.current = from;
    setStep('singing');
    setStatus(loop ? 'Looping. Sing along; each pass is scored.' : 'Sing!');
    if (!loop) startRecorder();
    await player.play({
      from,
      to,
      loop,
      tempo,
      semitones,
      gains,
      guideNotes: guide ? guideNotes : [],
      guideGain: exercise?.guideGain ?? 0.3,
      onEnded: async () => {
        const rec = await stopRecorder();
        const frames = framesRef.current;
        setStep('review');
        setStatus('');
        scoreTake(frames, rec);
      },
    });
  }

  function scoreTake(frames: PitchFrame[], rec: { blob: Blob; mime: string } | null) {
    if (!phrase) return;
    const sc = scorePhrase(analysis, phrase, frames, { semitones, level, allowOctave });
    const results = new Map(sc.noteResults.map((r) => [r.noteId, r]));
    setFeedback({ scores: sc.scores, issues: sc.issues, tip: sc.tip, results, title: `phrase ${phraseIndex + 1}` });
    props.onActivity?.((phrase.end - phrase.start) / tempo);
    props.onAttempt({
      kind: 'phrase',
      phraseIndex,
      score: sc,
      frames: frames.slice(),
      tempo,
      semitones,
      startSongTime: takeStartRef.current,
      recording: rec,
    });
  }

  async function stop() {
    const st = step;
    player.stop();
    const rec = await stopRecorder();
    if (st === 'singing') {
      const frames = framesRef.current;
      if (loop) {
        finishIteration(frames);
      } else if (phrase && frames.length && frames[frames.length - 1].t > phrase.start + (phrase.end - phrase.start) * 0.5) {
        scoreTake(frames, rec);
      }
      setStep('review');
    } else if (st === 'fullrun') {
      finishFullRun(rec);
    } else {
      setStep('idle');
      props.onReplayDone?.();
    }
    setStatus('');
  }

  async function fullRun() {
    player.stop();
    setFeedback(null);
    setFullResult(null);
    framesRef.current = [];
    lastTRef.current = -1;
    const { gains, guide } = gainsFor(backing === 'vocals' ? 'original' : backing, false);
    const from = Math.max(0, (phrases[0]?.start ?? 0) - 2);
    const to = analysis.duration;
    takeStartRef.current = from;
    setMode('full');
    setStep('fullrun');
    setStatus('Full run. Sing the whole song; every phrase is scored at the end.');
    startRecorder();
    await player.play({
      from,
      to,
      loop: false,
      tempo,
      semitones,
      gains,
      guideNotes: guide ? guideNotes : [],
      guideGain: 0.25,
      onEnded: async () => {
        const rec = await stopRecorder();
        finishFullRun(rec);
      },
    });
  }

  function finishFullRun(rec: { blob: Blob; mime: string } | null) {
    const frames = framesRef.current.slice();
    const per: { phraseIndex: number; score: PhraseScore }[] = [];
    let wsum = 0;
    let acc = 0;
    const lastT = frames.length ? frames[frames.length - 1].t : 0;
    for (const p of phrases) {
      if (p.start > lastT) break; // stopped early: only score what was sung
      const sc = scorePhrase(analysis, p, frames, { semitones, level, allowOctave });
      per.push({ phraseIndex: p.index, score: sc });
      const w = p.end - p.start;
      wsum += w;
      acc += w * sc.scores.overall;
    }
    const overall = wsum ? Math.round(acc / wsum) : 0;
    setFullResult({ overall, perPhrase: per });
    setStep('review');
    setStatus('');
    if (per.length === 0) return;
    const agg = (k: keyof CriterionScore) => Math.round(per.reduce((a, b) => a + b.score.scores[k], 0) / per.length);
    const allIssues = per.flatMap((p) => p.score.issues).sort((a, b) => b.severity - a.severity);
    const worst = [...per].sort((a, b) => a.score.scores.overall - b.score.scores.overall)[0];
    const combined: PhraseScore = {
      scores: { pitch: agg('pitch'), timing: agg('timing'), length: agg('length'), expression: agg('expression'), overall },
      issues: allIssues,
      noteResults: per.flatMap((p) => p.score.noteResults),
      tip: worst.score.tip,
    };
    props.onActivity?.((lastT - takeStartRef.current) / tempo);
    props.onAttempt({
      kind: 'full',
      phraseIndex: null,
      score: combined,
      frames,
      tempo,
      semitones,
      startSongTime: takeStartRef.current,
      perPhrase: per,
      recording: rec,
    });
  }

  // ---- replay a saved take ----
  useEffect(() => {
    const r = props.replayRequest;
    if (!r) return;
    player.stop();
    framesRef.current = r.frames;
    setStep('replaying');
    setStatus('Replaying your take against the original.');
    player.play({
      from: r.from,
      to: r.to,
      loop: false,
      tempo: r.tempo,
      semitones: r.semitones,
      gains: hasStems ? { instrumental: 0.5, vocals: 0.35 } : hasOriginal ? { original: 0.5 } : {},
      recording: { buffer: r.buffer, start: r.start, tempo: r.tempo, gain: 1 },
      onEnded: () => {
        setStep('idle');
        setStatus('');
        props.onReplayDone?.();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.replayRequest]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (step === 'singing' || step === 'listening' || step === 'fullrun' || step === 'replaying') stop();
        else sing();
      } else if (e.key === 'l' || e.key === 'L') listen();
      else if (e.key === 'ArrowRight') setPhraseIndex((i) => Math.min(phrases.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setPhraseIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, phrase, backing, tempo, loop, semitones]);

  const busy = step === 'singing' || step === 'listening' || step === 'fullrun' || step === 'replaying';
  const getTime = useCallback(() => player.position(), []);
  const currentTargetMidi = (() => {
    const t = player.position();
    if (t === null) return null;
    const n = analysis.notes.find((x) => t >= x.start - 0.05 && t <= x.end + 0.05);
    return n ? n.midi + semitones : null;
  })();
  const hardTags = phrase?.tags ?? [];
  const suggested = phrase ? exerciseForTags(hardTags) : null;
  const keyLabel = analysis.key ? keyName(transposeKey(analysis.key.tonic, semitones), analysis.key.mode) : null;

  const backingOptions: { id: Backing; label: string }[] = exercise
    ? [{ id: 'guide', label: 'Guide tone' }]
    : hasStems
      ? [
          { id: 'instrumental+guide', label: 'Band + guide' },
          { id: 'instrumental', label: 'Band only' },
          { id: 'vocals', label: 'Vocal only' },
          { id: 'original', label: 'Original' },
          { id: 'guide', label: 'Guide only' },
        ]
      : hasOriginal
        ? [
            { id: 'original+guide', label: 'Song + guide' },
            { id: 'original', label: 'Song only' },
            { id: 'guide', label: 'Guide only' },
          ]
        : [{ id: 'guide', label: 'Guide tone' }];

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row between">
        <div>
          <h1 style={{ marginBottom: 2 }}>{props.title}</h1>
          <div className="muted small row" style={{ gap: 8 }}>
            {props.subtitle && <span>{props.subtitle}</span>}
            {keyLabel && (
              <span className="pill">
                {semitones === 0 ? 'Original key' : 'Key'}: {keyLabel}
              </span>
            )}
            {analysis.mode === 'mix' && !exercise && (
              <span className="pill near" title="Melody taken from the full mix; the vocal is not isolated">
                Fallback mode
              </span>
            )}
            {analysis.mode === 'separated' && !exercise && <span className="pill good">Isolated vocal</span>}
          </div>
        </div>
        <div className="row">
          {!exercise && (
            <div className="seg" title="Practise phrase by phrase, or sing the whole song">
              <button className={mode === 'phrase' ? 'active' : ''} onClick={() => setMode('phrase')} disabled={busy}>
                Phrases
              </button>
              <button className={mode === 'full' ? 'active' : ''} onClick={() => setMode('full')} disabled={busy}>
                Full run
              </button>
            </div>
          )}
        </div>
      </div>

      {props.banner}
      {leakWarn && (
        <div className="banner warn">
          The microphone heard the guide tone while you were only listening. Sound is leaking from your speakers: put headphones on, or scores
          will be wrong.
          <button onClick={() => setLeakWarn(false)}>Dismiss</button>
        </div>
      )}
      {strainWarn && (
        <div className="banner bad">
          Those top notes sound pushed and are clipping the microphone. Ease off: sing them softer, or lower the key a couple of semitones. Never
          force a note that hurts.
          <button onClick={() => setStrainWarn(false)}>OK</button>
        </div>
      )}

      {/* settings row */}
      <div className="row between card flat" style={{ padding: '10px 14px' }}>
        <div className="row" style={{ gap: 18 }}>
          {props.onSemitones && (
            <label className="row small" style={{ gap: 8 }}>
              <span className="muted">Key</span>
              <select
                value={semitones}
                disabled={busy}
                onChange={(e) => props.onSemitones?.(parseInt(e.target.value, 10))}
                style={{ width: 'auto', padding: '6px 10px' }}
              >
                {Array.from({ length: 20 }, (_, i) => 7 - i).map((k) => {
                  const kn = analysis.key ? keyName(transposeKey(analysis.key.tonic, k), analysis.key.mode) : null;
                  const rec = props.recommendedSemitones === k;
                  return (
                    <option key={k} value={k}>
                      {k === 0 ? 'Original key' : `${k > 0 ? '+' : ''}${k} semitones`}
                      {kn ? ` (${kn})` : ''}
                      {rec && k !== 0 ? ' · recommended for your range' : ''}
                      {k < 0 && !rec ? ' · lower (easier)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          <label className="row small" style={{ gap: 8 }}>
            <span className="muted">Speed</span>
            <div className="seg">
              {TEMPOS.map((t) => (
                <button key={t} className={tempo === t ? 'active' : ''} disabled={busy} onClick={() => setTempo(t)}>
                  {Math.round(t * 100)}%
                </button>
              ))}
            </div>
          </label>
          <label className="row small" style={{ gap: 8 }}>
            <span className="muted">Hear</span>
            <div className="seg">
              {backingOptions.map((b) => (
                <button key={b.id} className={backing === b.id ? 'active' : ''} disabled={busy} onClick={() => setBacking(b.id)}>
                  {b.label}
                </button>
              ))}
            </div>
          </label>
          {mode === 'phrase' && (
            <label className="toggle small">
              <input type="checkbox" checked={loop} disabled={busy} onChange={(e) => setLoop(e.target.checked)} /> Loop the phrase
            </label>
          )}
        </div>
        {preparing && <span className="pill accent">Preparing audio…</span>}
      </div>

      <div className="practice-layout">
        <div className="col" style={{ gap: 12 }}>
          <div className="roll-wrap">
            <PianoRoll
              analysis={analysis}
              semitones={semitones}
              level={level}
              getTime={getTime}
              staticTime={phrase ? phrase.start : 0}
              framesRef={framesRef}
              phrase={mode === 'phrase' && phrase ? { start: phrase.start, end: phrase.end } : null}
              results={feedback?.results ?? null}
              allowOctave={allowOctave}
              follow={busy || mode === 'full'}
              windowSeconds={mode === 'full' ? 8 : 6}
              height={430}
            />
          </div>

          {/* transport */}
          <div className="row between card flat" style={{ padding: '12px 14px' }}>
            <div className="row">
              {mode === 'phrase' ? (
                <>
                  <button disabled={busy || phraseIndex === 0} onClick={() => setPhraseIndex((i) => i - 1)} title="Previous phrase (←)">
                    ◀
                  </button>
                  <button className="big" disabled={busy || !phrase} onClick={listen} title="Hear the target notes (L)">
                    Listen
                  </button>
                  {busy ? (
                    <button className="big danger" onClick={stop} title="Stop (space)">
                      ■ Stop
                    </button>
                  ) : (
                    <button className="big primary" disabled={!phrase} onClick={sing} title="Sing (space)">
                      ● Sing
                    </button>
                  )}
                  <button disabled={busy || phraseIndex >= phrases.length - 1} onClick={() => setPhraseIndex((i) => i + 1)} title="Next phrase (→)">
                    ▶
                  </button>
                </>
              ) : busy ? (
                <button className="big danger" onClick={stop}>
                  ■ Stop
                </button>
              ) : (
                <button className="big primary" onClick={fullRun}>
                  ● Sing the whole song
                </button>
              )}
            </div>
            <div className="muted small">
              {status || (mode === 'phrase' ? 'Listen first, then sing. Space = sing/stop, L = listen.' : 'Sing the whole song in one take.')}
              {loop && step === 'singing' && ` Pass ${iteration + 1}.`}
            </div>
          </div>

          {/* phrase strip */}
          {mode === 'phrase' && (
            <div className="phrase-strip">
              {phrases.map((p) => (
                <button key={p.index} className={p.index === phraseIndex ? 'current' : ''} disabled={busy} onClick={() => setPhraseIndex(p.index)}>
                  <span>
                    {exercise ? 'Rep' : 'Phrase'} {p.index + 1} <span className="tiny muted">{fmtTime(p.start)}</span>
                  </span>
                  <span className="txt">{p.text || `${p.noteIds.length} notes · ${'★'.repeat(p.difficulty)}`}</span>
                </button>
              ))}
            </div>
          )}

          {/* full run result */}
          {fullResult && mode === 'full' && (
            <div className="card col fade-in">
              <div className="row between">
                <h2>Full run</h2>
                <ScoreRing value={fullResult.overall} label="overall" />
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Phrase</th>
                    <th>Words</th>
                    <th>Score</th>
                    <th>Pitch</th>
                    <th>Timing</th>
                    <th>Length</th>
                    <th>Biggest issue</th>
                  </tr>
                </thead>
                <tbody>
                  {fullResult.perPhrase.map((p) => (
                    <tr key={p.phraseIndex}>
                      <td>{p.phraseIndex + 1}</td>
                      <td className="muted small">{phrases[p.phraseIndex].text.slice(0, 40)}</td>
                      <td>
                        <b>{p.score.scores.overall}</b>
                      </td>
                      <td>{p.score.scores.pitch}</td>
                      <td>{p.score.scores.timing}</td>
                      <td>{p.score.scores.length}</td>
                      <td className="small">{p.score.issues[0]?.text ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                <button
                  onClick={() => {
                    const worst = [...fullResult.perPhrase].sort((a, b) => a.score.scores.overall - b.score.scores.overall)[0];
                    if (worst) {
                      setMode('phrase');
                      setPhraseIndex(worst.phraseIndex);
                    }
                  }}
                >
                  Practise the weakest phrase
                </button>
              </div>
            </div>
          )}
        </div>

        {/* right column */}
        <div className="col" style={{ gap: 12 }}>
          <div className="card">
            <PitchMeter frame={frame} targetMidi={busy ? currentTargetMidi : null} tolerance={level === 'advanced' ? 20 : level === 'intermediate' ? 35 : 50} />
          </div>
          {exercise && (
            <div className="card flat" style={{ background: 'var(--accent-soft)', borderColor: '#c7cdfd' }}>
              <b>How</b>
              <div className="small">{exercise.cue}</div>
            </div>
          )}
          {phrase && mode === 'phrase' && !feedback && (
            <div className="card">
              <div className="tiny muted">
                {exercise ? 'Rep' : 'Phrase'} {phraseIndex + 1} of {phrases.length} · {'★'.repeat(phrase.difficulty)}
              </div>
              {phrase.text && <p style={{ fontWeight: 600, marginTop: 4 }}>{phrase.text}</p>}
              <div className="row" style={{ gap: 6 }}>
                {phrase.tags.map((t) => (
                  <span key={t} className="pill">
                    {t.replace('-', ' ')}
                  </span>
                ))}
              </div>
              <div className="small muted" style={{ marginTop: 8 }}>
                {phraseNotes.length} notes, {midiToName(Math.min(...phraseNotes.map((n) => n.midi)) + semitones)} to{' '}
                {midiToName(Math.max(...phraseNotes.map((n) => n.midi)) + semitones)}
                {phraseNotes.some((n) => n.slideIn) && ' · has slides'}
                {phraseNotes.some((n) => n.vibrato) && ' · vibrato on long notes'}
                {phraseNotes.some((n) => n.breathBefore) && ' · breath marked ˅'}
              </div>
              {suggested && !exercise && (
                <div className="small" style={{ marginTop: 8 }}>
                  Hard bit here? <Link to={`/exercise/${suggested.id}`}>{suggested.name}</Link> trains it.
                </div>
              )}
              {props.recommendReason && semitones !== (props.recommendedSemitones ?? 0) && props.recommendedSemitones !== undefined && (
                <div className="small muted" style={{ marginTop: 8 }}>
                  {props.recommendReason}{' '}
                  <a onClick={() => props.onSemitones?.(props.recommendedSemitones!)} style={{ cursor: 'pointer' }}>
                    Use {props.recommendedSemitones > 0 ? '+' : ''}
                    {props.recommendedSemitones}.
                  </a>
                </div>
              )}
            </div>
          )}
          {feedback && (
            <div className="card">
              <FeedbackPanel
                scores={feedback.scores}
                issues={feedback.issues}
                tip={feedback.tip}
                title={feedback.title}
                onRetry={busy ? undefined : sing}
                onNext={!busy && phraseIndex < phrases.length - 1 ? () => setPhraseIndex((i) => i + 1) : undefined}
                compact
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
