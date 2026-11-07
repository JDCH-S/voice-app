import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AdaptiveSettings, CriterionScore, GameResult, Level, NoteIssue, NoteResult, PhraseAttempt, PitchFrame, SongAnalysis, Tip, WordTiming } from '../lib/types';
import { player, type TrackKind } from '../lib/audio/Player';
import { mic, type RawPitch } from '../lib/audio/MicAnalyzer';
import { useMicPitch } from '../lib/useMic';
import { scorePhrase, type PhraseScore } from '../lib/scoring/score';
import type { TechniqueSummary } from '../lib/scoring/technique';
import PianoRoll, { STAR_POP_MS, type StarPop } from './PianoRoll';
import PitchMeter from './PitchMeter';
import FeedbackPanel, { worstTechnique } from './FeedbackPanel';
import ScoreRing from './ScoreRing';
import VoiceQualityMeter from './practice/VoiceQualityMeter';
import HearItFixed, { type FixPlayback, type TakeForFix } from './practice/HearItFixed';
import GameHud, { GameEndScreen, Stars } from './practice/GameHud';
import { useRollHeight } from './practice/useRollHeight';
import { fmtTime, midiToName, transposeKey, keyName, uid } from '../lib/music/notes';
import { exerciseForTags } from '../lib/exercises/library';
import { defaultSettings, nextSettings } from '../lib/adaptive';
import { KaraokeScorer, bestGame, type GameOutcome } from '../lib/game';
import { listGames, saveGame } from '../lib/store/db';
import { useApp } from '../lib/AppContext';
import { Link } from 'react-router-dom';
import '../styles-practice.css';

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

/** A previously saved take to replay: decoded buffer + metadata. */
export interface ReplayTake {
  buffer: AudioBuffer;
  start: number;
  tempo: number;
  semitones: number;
  frames: PitchFrame[];
  from: number;
  to: number;
  /** shown while it plays ("Then: 3 May, scored 61") */
  label?: string;
}

export type PracticeMode = 'phrase' | 'full' | 'game';

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
  replayRequest?: ReplayTake | null;
  onReplayDone?: () => void;
  /** Then vs now: play `first` and then `latest` back to back, each with its own trail. */
  compareRequest?: { first: ReplayTake; latest: ReplayTake } | null;
  onCompareDone?: () => void;
  /** Song id: enables Game mode (results are saved to the games store). */
  songId?: string | null;
  /** Word-level timing from speech recognition, when the song has it. */
  words?: WordTiming[] | null;
  /** Earlier attempts at this song (for adaptive difficulty: only attempts at the current tempo count). */
  priorAttempts?: PhraseAttempt[];
  onPhraseChange?: (phraseIndex: number) => void;
  onModeChange?: (mode: PracticeMode) => void;
}

type Step = 'idle' | 'listening' | 'singing' | 'review' | 'replaying' | 'fullrun' | 'game';

const TEMPOS = [1, 0.85, 0.7, 0.5];
const PREROLL = 1.2;

const hasGuide = (b: Backing) => b === 'guide' || b.endsWith('+guide');

export default function PracticeSession(props: PracticeSessionProps) {
  const { analysis, level, allowOctave, semitones, hasStems, hasOriginal, exercise } = props;
  const phrases = analysis.phrases;
  const { profile, updateProfile } = useApp();
  const adaptiveOn = !exercise && (profile?.adaptiveDifficulty ?? true);
  const [phraseIndex, setPhraseIndex] = useState(Math.min(props.initialPhrase ?? 0, Math.max(0, phrases.length - 1)));
  const [tempo, setTempo] = useState(1);
  const [loop, setLoop] = useState(false);
  const [mode, setMode] = useState<PracticeMode>(props.exercise ? 'phrase' : 'full');
  const [startAt, setStartAt] = useState(0); // phrase index where sing-along starts
  const defaultBacking: Backing = exercise ? 'guide' : hasStems ? 'instrumental+guide' : hasOriginal ? 'original+guide' : 'guide';
  const [backing, setBacking] = useState<Backing>(defaultBacking);
  // when the isolated vocal arrives mid-session, move from the full song to the band without a remount
  const prevStems = useRef(hasStems);
  useEffect(() => {
    if (hasStems && !prevStems.current) {
      setBacking((b) => (b === 'original+guide' ? 'instrumental+guide' : b));
    }
    prevStems.current = hasStems;
  }, [hasStems]);
  const [step, setStep] = useState<Step>('idle');
  const [preparing, setPreparing] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [feedback, setFeedback] = useState<{ scores: CriterionScore; issues: NoteIssue[]; tip: Tip; results: Map<number, NoteResult>; title: string; technique?: TechniqueSummary } | null>(null);
  const [fullResult, setFullResult] = useState<{ overall: number; perPhrase: { phraseIndex: number; score: PhraseScore }[] } | null>(null);
  const [leakWarn, setLeakWarn] = useState(false);
  const [strainWarn, setStrainWarn] = useState(false);
  const [micWarn, setMicWarn] = useState<null | 'silent' | 'unclear'>(null);
  const [adaptiveNote, setAdaptiveNote] = useState<string | null>(null);
  const [lastTake, setLastTake] = useState<(TakeForFix & { kind: 'phrase' | 'full' }) | null>(null);
  const [fixPlaying, setFixPlaying] = useState<FixPlayback | null>(null);
  const [gameEnd, setGameEnd] = useState<{ outcome: GameOutcome; best: GameResult | null; isNewBest: boolean } | null>(null);
  const hearStats = useRef({ start: 0, frames: 0, voiced: 0, maxDb: -100 });
  const [iteration, setIteration] = useState(0);
  const { frame } = useMicPitch(true);
  const { height: rollHeight, phone } = useRollHeight();

  const framesRef = useRef<PitchFrame[]>([]); // frames drawn on the roll (current iteration / take)
  const stepRef = useRef<Step>('idle');
  stepRef.current = step;
  const tempoRef = useRef(tempo);
  tempoRef.current = tempo;
  const backingRef = useRef(backing);
  backingRef.current = backing;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const lastTRef = useRef<number>(-1);
  const iterStartRef = useRef<number>(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const strainCount = useRef(0);
  const leakCount = useRef({ hit: 0, total: 0 });
  const guideNotesRef = useRef<{ start: number; end: number; midi: number }[]>([]);
  const takeStartRef = useRef<number>(0);
  const attemptsRef = useRef<Map<number, PhraseAttempt[]>>(new Map());
  const scorerRef = useRef<KaraokeScorer | null>(null);
  const starPopsRef = useRef<StarPop[]>([]);
  const latency = props.latencyMs / 1000;

  const phrase = phrases[phraseIndex] ?? null;
  const phraseNotes = useMemo(() => (phrase ? phrase.noteIds.map((id) => analysis.notes[id]) : []), [phrase, analysis]);
  const guideNotes = useMemo(() => analysis.notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi })), [analysis]);
  guideNotesRef.current = guideNotes;
  const words = useMemo(() => (props.words && props.words.length ? [...props.words].sort((a, b) => a.t0 - b.t0) : null), [props.words]);

  useEffect(() => {
    const unsub = player.subscribe(() => setPreparing(player.preparing));
    return () => {
      unsub();
      player.stop();
    };
  }, []);

  // earlier attempts feed the adaptive engine
  useEffect(() => {
    const m = new Map<number, PhraseAttempt[]>();
    for (const a of [...(props.priorAttempts ?? [])].sort((x, y) => x.date - y.date)) {
      const list = m.get(a.phraseIndex) ?? [];
      list.push(a);
      m.set(a.phraseIndex, list);
    }
    // keep attempts made in this session
    for (const [k, list] of attemptsRef.current) {
      const prev = m.get(k) ?? [];
      const ids = new Set(prev.map((a) => a.id));
      m.set(k, [...prev, ...list.filter((a) => !ids.has(a.id))]);
    }
    attemptsRef.current = m;
  }, [props.priorAttempts]);

  // the level decides where a song starts (advanced: full speed, no guide) when auto-adjust is on
  const defaultsApplied = useRef(false);
  useEffect(() => {
    if (defaultsApplied.current || exercise || !profile) return;
    defaultsApplied.current = true;
    if (!(profile.adaptiveDifficulty ?? true)) return;
    // tempo and guide come from the level; looping stays the singer's own choice
    const d = defaultSettings(level);
    setTempo(d.tempo);
    setBacking((b) => withGuide(b, d.guide));
    setAdaptiveNote(
      d.tempo < 1
        ? `Starting at ${Math.round(d.tempo * 100)}% with the guide tone on. We adjust the speed and the guide from your scores after each take.`
        : d.guide
          ? 'Starting at full speed with the guide tone on. We adjust after each take.'
          : 'Full speed, no guide tone: show me what you have got. We adjust after each take.',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, level, exercise]);

  useEffect(() => {
    props.onPhraseChange?.(phraseIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phraseIndex]);
  useEffect(() => {
    props.onModeChange?.(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // reset when phrase changes
  useEffect(() => {
    player.stop();
    setStep('idle');
    setFeedback(null);
    setLastTake(null);
    setFixPlaying(null);
    framesRef.current = [];
    setIteration(0);
  }, [phraseIndex, semitones, analysis]);

  function withGuide(b: Backing, on: boolean): Backing {
    if (on) {
      if (b === 'instrumental') return 'instrumental+guide';
      if (b === 'original') return 'original+guide';
      if (b === 'vocals') return hasStems ? 'instrumental+guide' : 'guide';
      return b;
    }
    if (b === 'instrumental+guide') return 'instrumental';
    if (b === 'original+guide') return 'original';
    if (b === 'guide') return hasStems ? 'instrumental' : hasOriginal ? 'original' : 'guide';
    return b;
  }

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

  /** Accompaniment for replaying a take: the band (or the song, quietly) under the singer's voice. */
  const replayGains = useCallback((): Partial<Record<TrackKind, number>> => (hasStems ? { instrumental: 0.5, vocals: 0.35 } : hasOriginal ? { original: 0.5 } : {}), [hasStems, hasOriginal]);

  // ---- microphone frames → song time, live drawing, loop detection, game scoring ----
  useEffect(() => {
    const unsub = mic.subscribe((f: RawPitch) => {
      const st = stepRef.current;
      if (st !== 'singing' && st !== 'listening' && st !== 'fullrun' && st !== 'game') return;
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
      const pf: PitchFrame = {
        t,
        hz: f.hz,
        midi: f.midi,
        rms: f.rms,
        db: f.db,
        clarity: f.clarity,
        voicing: f.voicing,
        hnr: f.hnr,
        breathiness: f.breathiness,
        pressed: f.pressed,
        centroid: f.centroid,
        tilt: f.tilt,
        peak: f.peak,
      };
      // can we hear the singer at all? judged over the first seconds of each take
      const hs = hearStats.current;
      if (hs.start === 0) hs.start = performance.now();
      const elapsed = (performance.now() - hs.start) / 1000;
      if (elapsed > 1.2) {
        hs.frames++;
        if (f.hz > 0 && f.clarity > 0.5) hs.voiced++;
        hs.maxDb = Math.max(hs.maxDb, f.db);
        if (elapsed > 6 && hs.frames > 100) {
          if (hs.voiced / hs.frames < 0.03) setMicWarn(hs.maxDb < -50 ? 'silent' : 'unclear');
          else setMicWarn(null);
        }
      }
      // loop wrap: time jumped backwards → finish previous iteration
      if (st === 'singing' && lastTRef.current >= 0 && t < lastTRef.current - 1.0) {
        finishIteration(framesRef.current);
        framesRef.current = [];
        iterStartRef.current = performance.now();
        setIteration((i) => i + 1);
      }
      lastTRef.current = t;
      framesRef.current.push(pf);
      // game: feed the scorer, pop stars on finished phrases
      if (st === 'game' && scorerRef.current) {
        const events = scorerRef.current.feed(pf);
        if (events.length) {
          const now = performance.now();
          for (const ev of events) if (ev.type === 'phrase') starPopsRef.current.push({ phraseIndex: ev.phraseIndex, stars: ev.stars, at: now });
          starPopsRef.current = starPopsRef.current.filter((p) => now - p.at < STAR_POP_MS + 200);
        }
      }
      // strain heuristic: pushed, clipping high notes
      if (props.highMidi && f.hz > 0 && f.midi >= props.highMidi - 1 && f.peak > 0.95) {
        strainCount.current++;
        if (strainCount.current > 12) setStrainWarn(true);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latency, semitones, phraseIndex, tempo, level, allowOctave]);

  /** Remember a phrase attempt for the adaptive engine. */
  function rememberAttempt(pi: number, sc: PhraseScore, atTempo: number) {
    const a: PhraseAttempt = {
      id: uid(),
      songId: props.songId ?? '',
      phraseIndex: pi,
      date: Date.now(),
      semitones,
      tempo: atTempo,
      scores: sc.scores,
      issues: sc.issues,
      tip: sc.tip,
      frames: [],
      noteResults: sc.noteResults,
    };
    const list = attemptsRef.current.get(pi) ?? [];
    list.push(a);
    attemptsRef.current.set(pi, list);
  }

  /** Apply the adaptive engine's recommendation for the next attempt at phrase `pi` (when the toggle is on). */
  function applyAdaptive(pi: number) {
    if (!adaptiveOn) return;
    const current: AdaptiveSettings = { tempo: tempoRef.current, guide: hasGuide(backingRef.current), loop: loopRef.current, reason: '' };
    const next = nextSettings(attemptsRef.current.get(pi) ?? [], current, level);
    if (Math.abs(next.tempo - current.tempo) > 1e-6) setTempo(next.tempo);
    if (next.guide !== current.guide) setBacking(withGuide(backingRef.current, next.guide));
    if (next.loop !== current.loop) setLoop(next.loop);
    setAdaptiveNote(next.reason);
  }

  const finishIteration = useCallback(
    (frames: PitchFrame[]) => {
      if (!phrase) return;
      // need to have covered at least half of the phrase in time
      const covered = frames.length ? frames[frames.length - 1].t - Math.max(frames[0].t, phrase.start) : 0;
      if (covered < (phrase.end - phrase.start) * 0.5) return;
      const sc = scorePhrase(analysis, phrase, frames, { semitones, level, allowOctave, highMidi: props.highMidi ?? undefined });
      const results = new Map(sc.noteResults.map((r) => [r.noteId, r]));
      setFeedback({ scores: sc.scores, issues: sc.issues, tip: sc.tip, results, title: `phrase ${phraseIndex + 1}`, technique: sc.technique });
      rememberAttempt(phraseIndex, sc, tempo);
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
    hearStats.current = { start: 0, frames: 0, voiced: 0, maxDb: -100 };
    setFeedback(null);
    setLastTake(null);
    setFixPlaying(null);
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
    const atTempo = tempoRef.current;
    const sc = scorePhrase(analysis, phrase, frames, { semitones, level, allowOctave, highMidi: props.highMidi ?? undefined });
    const results = new Map(sc.noteResults.map((r) => [r.noteId, r]));
    setFeedback({ scores: sc.scores, issues: sc.issues, tip: sc.tip, results, title: `phrase ${phraseIndex + 1}`, technique: sc.technique });
    rememberAttempt(phraseIndex, sc, atTempo);
    if (rec) {
      setLastTake({
        id: uid(),
        kind: 'phrase',
        label: `phrase ${phraseIndex + 1}`,
        blob: rec.blob,
        mime: rec.mime,
        frames: frames.slice(),
        noteResults: sc.noteResults,
        startSongTime: takeStartRef.current,
        tempo: atTempo,
        semitones,
        from: takeStartRef.current,
        to: phrase.end + 0.4,
      });
    }
    props.onActivity?.((phrase.end - phrase.start) / atTempo);
    props.onAttempt({
      kind: 'phrase',
      phraseIndex,
      score: sc,
      frames: frames.slice(),
      tempo: atTempo,
      semitones,
      startSongTime: takeStartRef.current,
      recording: rec,
    });
    applyAdaptive(phraseIndex);
  }

  async function stop() {
    const st = step;
    player.stop();
    const rec = await stopRecorder();
    setFixPlaying(null);
    if (st === 'singing') {
      const frames = framesRef.current;
      if (loop) {
        finishIteration(frames);
        applyAdaptive(phraseIndex);
      } else if (phrase && frames.length && frames[frames.length - 1].t > phrase.start + (phrase.end - phrase.start) * 0.5) {
        scoreTake(frames, rec);
      }
      setStep('review');
    } else if (st === 'fullrun') {
      finishFullRun(rec);
    } else if (st === 'game') {
      finishGame();
    } else {
      setStep('idle');
      props.onReplayDone?.();
      props.onCompareDone?.();
    }
    setStatus('');
  }

  async function fullRun() {
    player.stop();
    hearStats.current = { start: 0, frames: 0, voiced: 0, maxDb: -100 };
    setFeedback(null);
    setFullResult(null);
    setLastTake(null);
    setFixPlaying(null);
    framesRef.current = [];
    lastTRef.current = -1;
    const { gains, guide } = gainsFor(backing === 'vocals' ? 'original' : backing, false);
    const from = Math.max(0, (phrases[startAt]?.start ?? 0) - 2);
    const to = analysis.duration;
    takeStartRef.current = from;
    setMode('full');
    setStep('fullrun');
    setStatus('Sing with the song. White circle = where to sing now. Coloured dot = your voice. Move your voice onto the bars.');
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
    const atTempo = tempoRef.current;
    const per: { phraseIndex: number; score: PhraseScore }[] = [];
    let wsum = 0;
    let acc = 0;
    const lastT = frames.length ? frames[frames.length - 1].t : 0;
    for (const p of phrases) {
      if (p.start > lastT) break; // stopped early: only score what was sung
      if (p.end < takeStartRef.current) continue; // started later in the song
      const sc = scorePhrase(analysis, p, frames, { semitones, level, allowOctave, highMidi: props.highMidi ?? undefined });
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
    if (rec) {
      setLastTake({
        id: uid(),
        kind: 'full',
        label: 'sing-along',
        blob: rec.blob,
        mime: rec.mime,
        frames,
        noteResults: combined.noteResults,
        startSongTime: takeStartRef.current,
        tempo: atTempo,
        semitones,
        from: takeStartRef.current,
        to: Math.min(analysis.duration, lastT + 0.6),
      });
    }
    props.onActivity?.((lastT - takeStartRef.current) / atTempo);
    props.onAttempt({
      kind: 'full',
      phraseIndex: null,
      score: combined,
      frames,
      tempo: atTempo,
      semitones,
      startSongTime: takeStartRef.current,
      perPhrase: per,
      recording: rec,
    });
  }

  // ---- game mode: full-song karaoke with points, combo and stars ----
  async function playGame() {
    player.stop();
    hearStats.current = { start: 0, frames: 0, voiced: 0, maxDb: -100 };
    setGameEnd(null);
    setFeedback(null);
    setLastTake(null);
    setFixPlaying(null);
    framesRef.current = [];
    lastTRef.current = -1;
    starPopsRef.current = [];
    scorerRef.current = new KaraokeScorer(analysis, { semitones, level, tempo, allowOctave });
    const { gains, guide } = gainsFor(backing === 'vocals' ? 'original' : backing, false);
    const from = Math.max(0, (phrases[0]?.start ?? 0) - 2);
    const to = analysis.duration;
    takeStartRef.current = from;
    setMode('game');
    setStep('game');
    setStatus('Game on! Every moment on pitch earns points. Stay on the bars to grow your combo and multiplier.');
    await player.play({
      from,
      to,
      loop: false,
      tempo,
      semitones,
      gains,
      guideNotes: guide ? guideNotes : [],
      guideGain: 0.25,
      onEnded: () => finishGame(),
    });
  }

  function finishGame() {
    const sc = scorerRef.current;
    scorerRef.current = null;
    setStep('review');
    setStatus('');
    if (!sc) return;
    const outcome = sc.finish();
    const frames = framesRef.current;
    const lastT = frames.length ? frames[frames.length - 1].t : takeStartRef.current;
    props.onActivity?.(Math.max(0, lastT - takeStartRef.current) / tempoRef.current);
    const songId = props.songId;
    (async () => {
      let best: GameResult | null = null;
      if (songId) {
        try {
          best = bestGame(await listGames(songId), songId);
          await saveGame({ id: uid(), songId, date: Date.now(), ...outcome });
        } catch {
          /* storage unavailable: the result is still shown */
        }
      }
      setGameEnd({ outcome, best, isNewBest: !best || outcome.points > best.points });
    })();
  }

  const readGame = useCallback(() => scorerRef.current?.state ?? null, []);

  // ---- "Hear it fixed" playback: your take, the fixed take or the original singer, all aligned ----
  function playFix(what: FixPlayback, buffer: AudioBuffer | null) {
    const take = lastTake;
    if (!take) return;
    player.stop();
    framesRef.current = take.frames;
    setStep('replaying');
    setFixPlaying(what);
    setStatus(what === 'you' ? 'Your take, as you sang it.' : what === 'fixed' ? 'Your take with every note pulled onto the target.' : 'The original singer.');
    const gains: Partial<Record<TrackKind, number>> = what === 'original' ? (hasStems ? { vocals: 1, instrumental: 0.5 } : hasOriginal ? { original: 1 } : {}) : replayGains();
    player.play({
      from: take.from,
      to: take.to,
      loop: false,
      tempo: take.tempo,
      semitones: take.semitones,
      gains,
      guideNotes: what !== 'original' || hasStems || hasOriginal ? [] : guideNotes,
      guideGain: 0.35,
      recording: buffer ? { buffer, start: take.startSongTime, tempo: take.tempo, gain: 1 } : undefined,
      onEnded: () => {
        setStep('idle');
        setFixPlaying(null);
        setStatus('');
      },
    });
  }

  // ---- replay a saved take ----
  useEffect(() => {
    const r = props.replayRequest;
    if (!r) return;
    player.stop();
    framesRef.current = r.frames;
    setStep('replaying');
    setStatus(r.label ?? 'Replaying your take against the original.');
    player.play({
      from: r.from,
      to: r.to,
      loop: false,
      tempo: r.tempo,
      semitones: r.semitones,
      gains: replayGains(),
      recording: { buffer: r.buffer, start: r.start, tempo: r.tempo, gain: 1 },
      onEnded: () => {
        setStep('idle');
        setStatus('');
        props.onReplayDone?.();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.replayRequest]);

  // ---- then vs now: first take, a short pause, latest take ----
  useEffect(() => {
    const c = props.compareRequest;
    if (!c) return;
    let cancelled = false;
    let timer = 0;
    const playOne = (r: ReplayTake, fallback: string, then: () => void) => {
      framesRef.current = r.frames;
      setStep('replaying');
      setStatus(r.label ?? fallback);
      player.play({
        from: r.from,
        to: r.to,
        loop: false,
        tempo: r.tempo,
        semitones: r.semitones,
        gains: replayGains(),
        recording: { buffer: r.buffer, start: r.start, tempo: r.tempo, gain: 1 },
        onEnded: then,
      });
    };
    player.stop();
    playOne(c.first, 'Then: your first take.', () => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        playOne(c.latest, 'Now: your latest take.', () => {
          if (cancelled) return;
          setStep('idle');
          setStatus('');
          props.onCompareDone?.();
        });
      }, 500);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.compareRequest]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (step === 'singing' || step === 'listening' || step === 'fullrun' || step === 'replaying' || step === 'game') stop();
        else if (mode === 'full') fullRun();
        else if (mode === 'game') playGame();
        else sing();
      } else if (e.key === 'l' || e.key === 'L') {
        if (mode === 'phrase') listen();
      } else if (e.key === 'ArrowRight') setPhraseIndex((i) => Math.min(phrases.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setPhraseIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, phrase, backing, tempo, loop, semitones, mode, startAt, lastTake]);

  const busy = step === 'singing' || step === 'listening' || step === 'fullrun' || step === 'replaying' || step === 'game';
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
  const gameAvailable = !exercise && !!props.songId;

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

  const defaultStatus =
    mode === 'phrase'
      ? phone
        ? 'Listen first, then sing.'
        : 'Listen first, then sing. Space = sing/stop, L = listen.'
      : mode === 'game'
        ? 'The whole song plays. Every moment on pitch earns points; keep your dot on the bars to grow the combo.'
        : 'The song plays and the bars scroll. Sing along and steer your dot onto the bars.';

  const hearItFixed = lastTake && (
    <HearItFixed
      take={lastTake}
      analysis={analysis}
      songTitle={props.title}
      hasSinger={hasStems || hasOriginal}
      playing={fixPlaying}
      busy={busy && fixPlaying === null}
      onPlay={playFix}
      onStop={stop}
    />
  );

  return (
    <div className={`ps col ${phone ? 'ps-phone' : ''}`} style={{ gap: 14 }}>
      <div className="row between ps-head">
        <div className="ps-title">
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
            {words && !exercise && (
              <span className="pill accent" title="Each word is shown at the moment it is sung">
                Word timing
              </span>
            )}
          </div>
        </div>
        <div className="row ps-modes">
          {!exercise && (
            <div className="seg" title="Practise phrase by phrase, sing the whole song, or play for points">
              <button className={mode === 'full' ? 'active' : ''} onClick={() => setMode('full')} disabled={busy}>
                Sing along
              </button>
              <button className={mode === 'phrase' ? 'active' : ''} onClick={() => setMode('phrase')} disabled={busy}>
                Learn phrase by phrase
              </button>
              {gameAvailable && (
                <button className={`game-tab ${mode === 'game' ? 'active' : ''}`} onClick={() => setMode('game')} disabled={busy}>
                  Game
                </button>
              )}
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
      {micWarn && (
        <div className="banner bad">
          <div className="grow">
            {micWarn === 'silent'
              ? "We can't hear you. The microphone signal is almost silent: it may be muted, too quiet, or the wrong microphone may be selected. "
              : "We hear sound but no clear singing voice. Sing a little louder and closer to the microphone, and keep the music in your headphones only. "}
            Check the level bar under the note display: it should move when you sing. If it doesn't, run the microphone check in Settings and pick your microphone there.
          </div>
          <button onClick={() => setMicWarn(null)}>OK</button>
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
      <div className="row between card flat ps-settings" style={{ padding: '10px 14px' }}>
        <div className="row ps-settings-row" style={{ gap: 18 }}>
          {props.onSemitones && (
            <label className="row small" style={{ gap: 8 }}>
              <span className="muted">Key</span>
              <select
                value={semitones}
                disabled={busy}
                onChange={(e) => props.onSemitones?.(parseInt(e.target.value, 10))}
                className="ps-select"
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
                <button key={t} className={tempo === t ? 'active' : ''} disabled={busy} onClick={() => { setTempo(t); setAdaptiveNote(null); }}>
                  {Math.round(t * 100)}%
                </button>
              ))}
            </div>
          </label>
          <label className="row small" style={{ gap: 8 }}>
            <span className="muted">Hear</span>
            <div className="seg">
              {backingOptions.map((b) => (
                <button key={b.id} className={backing === b.id ? 'active' : ''} disabled={busy} onClick={() => { setBacking(b.id); setAdaptiveNote(null); }}>
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
          {!exercise && (
            <label className="toggle small" title="After each phrase, slow down or speed up and switch the guide tone on or off from your scores">
              <input
                type="checkbox"
                checked={adaptiveOn}
                disabled={busy}
                onChange={(e) => {
                  void updateProfile({ adaptiveDifficulty: e.target.checked });
                  if (!e.target.checked) setAdaptiveNote(null);
                }}
              />{' '}
              Auto-adjust difficulty
            </label>
          )}
        </div>
        {preparing && <span className="pill accent">Preparing audio…</span>}
      </div>

      <div className="practice-layout">
        <div className="col ps-main" style={{ gap: 12 }}>
          <div className={`roll-wrap ${mode === 'game' ? 'game' : ''}`}>
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
              follow={busy || mode !== 'phrase'}
              windowSeconds={mode === 'phrase' ? 6 : 8}
              height={rollHeight}
              words={words}
              starPops={starPopsRef}
            />
            {step === 'game' && <GameHud read={readGame} phraseCount={phrases.length} />}
          </div>

          <div className="legend ps-legend" style={{ padding: '0 4px' }}>
            <span>
              <i style={{ background: '#818cf8' }} />
              the correct notes
            </span>
            <span>
              <i style={{ background: 'transparent', border: '2px solid var(--ink)', borderRadius: '50%' }} />
              where to sing now
            </span>
            <span>
              <i style={{ background: '#22c55e', borderRadius: '50%' }} />
              your voice: green on the note
            </span>
            <span>
              <i style={{ background: '#f59e0b', borderRadius: '50%' }} />
              close
            </span>
            <span>
              <i style={{ background: '#ef4444', borderRadius: '50%' }} />
              off
            </span>
          </div>

          {/* transport */}
          <div className="row between card flat ps-transport" style={{ padding: '12px 14px' }}>
            <div className="row ps-transport-buttons">
              {mode === 'phrase' ? (
                <>
                  <button disabled={busy || phraseIndex === 0} onClick={() => setPhraseIndex((i) => i - 1)} title="Previous phrase (←)" aria-label="Previous phrase">
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
                  <button disabled={busy || phraseIndex >= phrases.length - 1} onClick={() => setPhraseIndex((i) => i + 1)} title="Next phrase (→)" aria-label="Next phrase">
                    ▶
                  </button>
                </>
              ) : busy ? (
                <button className="big danger" onClick={stop}>
                  ■ Stop
                </button>
              ) : mode === 'game' ? (
                <button className="big primary game-start" onClick={playGame}>
                  ▶ Start the game
                </button>
              ) : (
                <>
                  <button className="big primary" onClick={fullRun}>
                    ● Sing along
                  </button>
                  <label className="row small" style={{ gap: 6 }}>
                    <span className="muted">from</span>
                    <select value={startAt} onChange={(e) => setStartAt(parseInt(e.target.value, 10))} className="ps-select">
                      <option value={0}>the beginning</option>
                      {phrases.slice(1).map((p) => (
                        <option key={p.index} value={p.index}>
                          {fmtTime(p.start)} {p.text ? `· ${p.text.slice(0, 28)}` : `· phrase ${p.index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            <div className="muted small ps-status">
              {status || defaultStatus}
              {loop && step === 'singing' && ` Pass ${iteration + 1}.`}
            </div>
          </div>
          {adaptiveOn && adaptiveNote && mode === 'phrase' && (
            <div className="adaptive-note small" role="status">
              <span className="adaptive-icon" aria-hidden>
                ⟳
              </span>
              {adaptiveNote}
            </div>
          )}

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
                <h2>Sing-along results</h2>
                <ScoreRing value={fullResult.overall} label="overall" />
              </div>
              <div className="table-scroll">
                <div className="table-wrap"><table className="table">
                  <thead>
                    <tr>
                      <th>Phrase</th>
                      <th>Words</th>
                      <th>Score</th>
                      <th>Pitch</th>
                      <th>Timing</th>
                      <th>Length</th>
                      <th>Technique</th>
                      <th>Biggest issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fullResult.perPhrase.map((p) => {
                      const wt = worstTechnique(p.score.technique);
                      return (
                        <tr key={p.phraseIndex}>
                          <td>{p.phraseIndex + 1}</td>
                          <td className="muted small">{phrases[p.phraseIndex].text.slice(0, 40)}</td>
                          <td>
                            <b>{p.score.scores.overall}</b>
                          </td>
                          <td>{p.score.scores.pitch}</td>
                          <td>{p.score.scores.timing}</td>
                          <td>{p.score.scores.length}</td>
                          <td className="small">
                            {wt ? (
                              <span className="pill bad" title={`${wt.count} ${wt.count === 1 ? 'note' : 'notes'} ${wt.label}`}>
                                {wt.label}
                              </span>
                            ) : p.score.technique && p.score.technique.notesChecked > 0 ? (
                              <span className="pill good">clean</span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="small">{p.score.issues[0]?.text ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              </div>
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
              {lastTake?.kind === 'full' && hearItFixed}
            </div>
          )}

          {/* game end */}
          {mode === 'game' && gameEnd && (
            <GameEndScreen
              outcome={gameEnd.outcome}
              best={gameEnd.best}
              isNewBest={gameEnd.isNewBest}
              phraseTexts={phrases.map((p) => p.text)}
              onAgain={playGame}
              onPractise={(pi) => {
                setMode('phrase');
                setPhraseIndex(pi);
              }}
            />
          )}
          {mode === 'game' && !gameEnd && step !== 'game' && (
            <div className="card flat game-intro">
              <b>Game mode</b>
              <div className="small muted">
                The whole song plays and your voice earns points for every moment on pitch. Hit notes in a row to build a combo and a multiplier up to ×4;
                each phrase gets up to five stars. Go off pitch for more than a third of a second and the combo breaks. It is for fun: the honest coaching
                lives in the other two modes.
              </div>
              <div className="row tiny muted" style={{ gap: 10, marginTop: 6 }}>
                <span>
                  <Stars n={5} size={0.9} /> 95%+ on pitch
                </span>
                <span>
                  <Stars n={3} size={0.9} /> 70%+
                </span>
                <span>
                  <Stars n={1} size={0.9} /> 35%+
                </span>
              </div>
            </div>
          )}
        </div>

        {/* right column */}
        <div className="col ps-side" style={{ gap: 12 }}>
          <div className="card ps-meter">
            <PitchMeter frame={frame} targetMidi={busy ? currentTargetMidi : null} tolerance={level === 'advanced' ? 20 : level === 'intermediate' ? 35 : 50} />
            <div className="vq-wrap">
              <VoiceQualityMeter frame={frame} compact={phone} />
            </div>
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
          {feedback && mode === 'phrase' && (
            <div className="card">
              <FeedbackPanel
                scores={feedback.scores}
                issues={feedback.issues}
                tip={feedback.tip}
                title={feedback.title}
                technique={feedback.technique}
                onRetry={busy ? undefined : sing}
                onNext={!busy && phraseIndex < phrases.length - 1 ? () => setPhraseIndex((i) => i + 1) : undefined}
                compact
              />
              {lastTake?.kind === 'phrase' && (
                <>
                  <hr />
                  {hearItFixed}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
