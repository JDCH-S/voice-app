// Shared data model. See docs/ANALYSIS_SCHEMA.md for the analysis contract.

export type AnalysisMode = 'separated' | 'mix';
export type Dynamic = 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff';
export type Register = 'chest' | 'head' | 'mixed' | null;

export interface KeyInfo {
  tonic: string;
  mode: 'major' | 'minor';
  confidence: number;
}

export interface MelodyTrack {
  t0: number;
  hop: number;
  hz: number[];
  rmsDb: number[];
}

export interface RefNote {
  id: number;
  start: number;
  end: number;
  midi: number;
  cents: number;
  hzMedian: number;
  stabilityCents: number;
  slideIn: { fromMidi: number; duration: number } | null;
  run: boolean;
  vibrato: { rate: number; extentCents: number } | null;
  loudnessDb: number;
  dynamic: Dynamic;
  breathBefore: boolean;
  register: Register;
  lyric: string | null;
  phrase: number;
}

export type PhraseTag =
  | 'high-note'
  | 'low-note'
  | 'long-hold'
  | 'run'
  | 'wide-leap'
  | 'slide'
  | 'vibrato'
  | 'fast';

export interface Phrase {
  index: number;
  start: number;
  end: number;
  noteIds: number[];
  text: string;
  difficulty: number;
  tags: PhraseTag[];
}

export interface SongAnalysis {
  version: 1;
  mode: AnalysisMode;
  duration: number;
  key: KeyInfo | null;
  tempoBpm: number | null;
  melody: MelodyTrack;
  notes: RefNote[];
  phrases: Phrase[];
  breaths: number[];
  range: { lowMidi: number; highMidi: number; p05: number; p95: number };
  warnings: string[];
}

export interface LyricLine {
  t: number | null; // seconds, null when not synced
  text: string;
}

export interface Lyrics {
  source: 'lrclib' | 'manual' | 'none';
  synced: boolean;
  lines: LyricLine[];
}

// ---------- user data (stored in IndexedDB) ----------

export type Level = 'beginner' | 'intermediate' | 'advanced';
export type Goal = 'sing-songs' | 'pitch' | 'range' | 'technique' | 'confidence';

export interface RangeTest {
  date: number; // epoch ms
  lowMidi: number;
  highMidi: number;
  voiceType: string;
  accuracyCents: number; // mean abs error in match-the-note
  stabilityCents: number;
  accuracyScore: number; // 0..100
}

export interface MicCalibration {
  date: number;
  noiseFloorDb: number;
  singingLevelDb: number;
  gateDb: number;
  latencyMs: number;
  leakDetected: boolean;
  deviceLabel: string | null;
}

export interface Profile {
  id: 'me';
  createdAt: number;
  name: string;
  level: Level;
  goals: Goal[];
  rangeTests: RangeTest[];
  calibration: MicCalibration | null;
  allowOctave: boolean;
  onboardingDone: boolean;
  // ---- habit & adaptivity (all optional; defaults applied in code) ----
  dailyGoalMinutes?: number; // default 10
  reminderTime?: string | null; // "HH:MM" local, null = off
  adaptiveDifficulty?: boolean; // default true
  coachModel?: string | null; // override for the AI coach model
}

export interface SongRecord {
  id: string;
  createdAt: number;
  title: string;
  artist: string;
  duration: number;
  analysis: SongAnalysis;
  lyrics: Lyrics;
  mode: AnalysisMode;
  hasStems: boolean;
  preferredSemitones: number;
  recommendedSemitones: number;
  jobId: string | null; // pending server job (upgrade to separated when done)
  notesPracticed?: number;
  words?: WordTiming[] | null; // word-level timing from speech recognition, when available
}

export interface AudioAsset {
  id: string; // `${songId}:original` | `${songId}:vocals` | `${songId}:instrumental`
  songId: string;
  kind: 'original' | 'vocals' | 'instrumental';
  blob: Blob;
  mime: string;
}

export interface PitchFrame {
  t: number; // song seconds (already latency-compensated)
  hz: number; // 0 when unvoiced
  midi: number; // NaN when unvoiced
  rms: number; // linear 0..1
  db: number;
  clarity: number; // 0..1 periodicity (1 = perfectly periodic)
  // ---- voice quality (optional; produced by the pitch worklet when available) ----
  voicing?: number; // 0..1 probability the frame is voiced (after smoothing)
  hnr?: number; // harmonics-to-noise ratio in dB (breathy voice ≈ < 8, clear ≈ > 15)
  breathiness?: number; // 0..1 (derived from hnr and spectral tilt)
  pressed?: number; // 0..1 strain index (bright, loud, high; 1 = clearly pushed)
  centroid?: number; // spectral centroid in Hz
  tilt?: number; // spectral tilt in dB/octave (negative; less negative = brighter/pressed)
  peak?: number; // sample peak 0..1 (clipping ≥ 0.97)
}

/** One recognised word with its timing in the original recording (from speech recognition). */
export interface WordTiming {
  t0: number;
  t1: number;
  text: string;
  conf: number; // 0..1
}

export type IssueKind =
  | 'sharp'
  | 'flat'
  | 'octave'
  | 'late'
  | 'early'
  | 'short'
  | 'long'
  | 'missed'
  | 'unstable'
  | 'no-slide'
  | 'no-vibrato'
  | 'too-soft'
  | 'too-loud'
  | 'no-breath'
  | 'broke-line'
  | 'strain'
  | 'breathy'
  | 'crack'
  | 'out-of-air';

export interface NoteIssue {
  noteId: number;
  kind: IssueKind;
  amount: number; // cents, seconds, dB or ratio depending on kind
  text: string; // human readable, names the word/note
  severity: number; // 0..1
}

export interface CriterionScore {
  pitch: number;
  timing: number;
  length: number;
  expression: number; // slides, vibrato, dynamics, breath
  overall: number;
}

export interface PhraseAttempt {
  id: string;
  songId: string;
  phraseIndex: number;
  date: number;
  semitones: number;
  tempo: number;
  scores: CriterionScore;
  issues: NoteIssue[];
  tip: Tip;
  frames: PitchFrame[];
  noteResults: NoteResult[];
}

export interface NoteResult {
  noteId: number;
  sungMidi: number | null; // median
  centsError: number | null;
  onsetDelta: number | null; // s, + = late
  heldRatio: number | null;
  coverage: number;
  status: 'good' | 'sharp' | 'flat' | 'missed' | 'octave';
}

export interface Tip {
  title: string;
  detail: string;
  exerciseId: string | null;
}

export interface RecordingRecord {
  id: string;
  songId: string;
  date: number;
  kind: 'phrase' | 'full';
  phraseIndex: number | null;
  blob: Blob;
  mime: string;
  startSongTime: number; // song time at which the recording began
  tempo: number;
  semitones: number;
  frames: PitchFrame[];
  scores: CriterionScore;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  activeSeconds: number;
  songIds: string[];
  phraseAttemptIds: string[];
  exerciseResultIds: string[];
  recap: SessionRecap | null;
}

export interface SessionRecap {
  improved: string[];
  biggestFix: string;
  exerciseId: string | null;
  avgScore: number | null;
  bestScore: number | null;
}

export interface ExerciseResult {
  id: string;
  exerciseId: string;
  date: number;
  score: number;
  metrics: Record<string, number>;
  notes: string;
}

// ---------- learning model ----------

export type Mastery = 'new' | 'learning' | 'learned' | 'mastered';

/** Spaced-review state for one phrase of one song. */
export interface ReviewState {
  songId: string;
  phraseIndex: number;
  mastery: Mastery;
  bestScore: number;
  lastScore: number;
  lastPracticed: number; // epoch ms
  dueAt: number; // epoch ms: when it should be practised again
  intervalDays: number;
}

/** Settings the adaptive engine recommends for the next attempt at a phrase. */
export interface AdaptiveSettings {
  tempo: number; // 1, 0.85, 0.7 or 0.5
  guide: boolean; // guide tone on
  loop: boolean;
  reason: string; // one plain sentence for the singer
}

// ---------- karaoke game ----------

export interface GameResult {
  id: string;
  songId: string;
  date: number;
  score: number; // 0..100 weighted overall
  points: number; // running game points
  stars: number; // 0..5
  maxCombo: number;
  semitones: number;
  tempo: number;
  perPhrase: { phraseIndex: number; score: number; stars: number }[];
}

// ---------- AI coach ----------

export interface CoachMessage {
  role: 'user' | 'assistant';
  content: string;
  date: number;
}

export interface CoachThread {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  messages: CoachMessage[];
}

export interface WeeklyPlanDay {
  day: string; // 'Mon'..'Sun'
  focus: string;
  items: { kind: 'exercise' | 'song' | 'phrase' | 'rest' | 'range-test'; title: string; exerciseId?: string | null; songId?: string | null; phraseIndex?: number | null; minutes: number }[];
}

export interface WeeklyPlan {
  weekStart: number; // epoch ms (Monday 00:00 local)
  summary: string;
  days: WeeklyPlanDay[];
  source: 'coach' | 'rules';
}
