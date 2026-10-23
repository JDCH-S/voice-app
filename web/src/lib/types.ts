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
  clarity: number; // 0..1
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
  | 'strain';

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
