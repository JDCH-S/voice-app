// Export and import of everything Voice Coach stores in the browser, as one JSON file.
// Audio (recordings and song files) is optional and embedded as base64 when included.

import type {
  AudioAsset,
  CoachThread,
  ExerciseResult,
  GameResult,
  PhraseAttempt,
  Profile,
  RecordingRecord,
  ReviewState,
  SessionRecord,
  SongRecord,
} from '../types';
import { db, loadProfile, saveProfile } from './db';

export const EXPORT_FORMAT = 'voice-coach';
export const EXPORT_VERSION = 1;
export const EXPORT_EXTENSION = '.voicecoach.json';

/** A Blob serialised for JSON. */
export interface BlobData {
  base64: string;
  mime: string;
  bytes: number;
}

export type ExportedRecording = Omit<RecordingRecord, 'blob'> & { blob: BlobData };
export type ExportedAsset = Omit<AudioAsset, 'blob'> & { blob: BlobData };

export interface ExportFile {
  app: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  includesAudio: boolean;
  profile: Profile | null;
  songs: SongRecord[];
  attempts: PhraseAttempt[];
  sessions: SessionRecord[];
  exerciseResults: ExerciseResult[];
  reviews: ReviewState[];
  games: GameResult[];
  coachThreads: CoachThread[];
  settings: { key: string; value: unknown }[];
  recordings: ExportedRecording[];
  assets: ExportedAsset[];
}

export interface ExportOptions {
  includeAudio: boolean;
}

export interface ImportSummary {
  profile: boolean;
  songs: number;
  attempts: number;
  sessions: number;
  exerciseResults: number;
  reviews: number;
  games: number;
  coachThreads: number;
  settings: number;
  recordings: number;
  assets: number;
  includesAudio: boolean;
  exportedAt: number;
}

// ---------- base64 helpers (work in browsers and Node) ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function blobToData(blob: Blob, mime?: string): Promise<BlobData> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { base64: bytesToBase64(bytes), mime: mime || blob.type || 'application/octet-stream', bytes: bytes.length };
}

export function dataToBlob(d: BlobData): Blob {
  const bytes = base64ToBytes(d.base64);
  return new Blob([bytes], { type: d.mime || 'application/octet-stream' });
}

// ---------- export ----------

export async function collectExport(opts: ExportOptions): Promise<ExportFile> {
  const d = await db();
  const profile = (await d.get('profile', 'me')) ?? null;
  const songs = await d.getAll('songs');
  const attempts = await d.getAll('attempts');
  const sessions = await d.getAll('sessions');
  const exerciseResults = await d.getAll('exerciseResults');
  const reviews = (await d.getAll('reviews')).map(({ id: _id, ...r }) => r as ReviewState);
  const games = await d.getAll('games');
  const coachThreads = await d.getAll('coachThreads');
  const settings = await d.getAll('settings');
  const recordings: ExportedRecording[] = [];
  const assets: ExportedAsset[] = [];
  if (opts.includeAudio) {
    for (const r of await d.getAll('recordings')) {
      const { blob, ...rest } = r;
      recordings.push({ ...rest, blob: await blobToData(blob, r.mime) });
    }
    for (const a of await d.getAll('assets')) {
      const { blob, ...rest } = a;
      assets.push({ ...rest, blob: await blobToData(blob, a.mime) });
    }
  }
  return {
    app: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    includesAudio: opts.includeAudio,
    profile,
    songs,
    attempts,
    sessions,
    exerciseResults,
    reviews,
    games,
    coachThreads,
    settings,
    recordings,
    assets,
  };
}

export function exportFileName(now: number = Date.now()): string {
  const d = new Date(now);
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `voice-coach-${d.getFullYear()}-${m}-${day}${EXPORT_EXTENSION}`;
}

/** Build the export as a Blob ready to download. */
export async function exportAll(opts: ExportOptions): Promise<{ blob: Blob; filename: string; summary: ImportSummary }> {
  const file = await collectExport(opts);
  const json = JSON.stringify(file);
  return { blob: new Blob([json], { type: 'application/json' }), filename: exportFileName(file.exportedAt), summary: summarize(file) };
}

/** Trigger a browser download of a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}

// ---------- import ----------

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Parse and sanity-check an export file. Throws with a plain message when it is not one. */
export function parseExport(text: string): ExportFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || (raw as { app?: unknown }).app !== EXPORT_FORMAT) throw new Error('That file was not exported by Voice Coach.');
  const r = raw as Partial<ExportFile>;
  if (typeof r.version !== 'number' || r.version > EXPORT_VERSION) throw new Error('That file comes from a newer version of Voice Coach. Update the app first.');
  const withId = <T extends { id?: unknown }>(xs: T[]) => xs.filter((x) => x && typeof x === 'object' && typeof x.id === 'string');
  return {
    app: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: typeof r.exportedAt === 'number' ? r.exportedAt : 0,
    includesAudio: !!r.includesAudio,
    profile: r.profile && typeof r.profile === 'object' && (r.profile as Profile).id === 'me' ? (r.profile as Profile) : null,
    songs: withId(arr<SongRecord>(r.songs)).filter((s) => s.analysis && Array.isArray(s.analysis.phrases)),
    attempts: withId(arr<PhraseAttempt>(r.attempts)),
    sessions: withId(arr<SessionRecord>(r.sessions)),
    exerciseResults: withId(arr<ExerciseResult>(r.exerciseResults)),
    reviews: arr<ReviewState>(r.reviews).filter((x) => x && typeof x.songId === 'string' && typeof x.phraseIndex === 'number'),
    games: withId(arr<GameResult>(r.games)),
    coachThreads: withId(arr<CoachThread>(r.coachThreads)).map((t) => ({ ...t, messages: arr(t.messages) })),
    settings: arr<{ key: string; value: unknown }>(r.settings).filter((x) => x && typeof x.key === 'string'),
    recordings: withId(arr<ExportedRecording>(r.recordings)).filter((x) => x.blob && typeof x.blob.base64 === 'string'),
    assets: withId(arr<ExportedAsset>(r.assets)).filter((x) => x.blob && typeof x.blob.base64 === 'string'),
  };
}

export function summarize(f: ExportFile): ImportSummary {
  return {
    profile: !!f.profile,
    songs: f.songs.length,
    attempts: f.attempts.length,
    sessions: f.sessions.length,
    exerciseResults: f.exerciseResults.length,
    reviews: f.reviews.length,
    games: f.games.length,
    coachThreads: f.coachThreads.length,
    settings: f.settings.length,
    recordings: f.recordings.length,
    assets: f.assets.length,
    includesAudio: f.includesAudio,
    exportedAt: f.exportedAt,
  };
}

/** Merge two profiles: the imported one wins, range tests are the union (by date). */
export function mergeProfiles(current: Profile, imported: Profile): Profile {
  const byDate = new Map<number, Profile['rangeTests'][number]>();
  for (const t of [...(current.rangeTests ?? []), ...(imported.rangeTests ?? [])]) if (t && typeof t.date === 'number') byDate.set(t.date, t);
  const rangeTests = [...byDate.values()].sort((a, b) => a.date - b.date);
  return {
    ...current,
    ...imported,
    id: 'me',
    createdAt: Math.min(current.createdAt || Date.now(), imported.createdAt || Date.now()),
    rangeTests,
    calibration: imported.calibration ?? current.calibration,
    onboardingDone: current.onboardingDone || imported.onboardingDone,
  };
}

/**
 * Import an export file into the local database, merging by id (records with the same id are
 * replaced by the imported ones, everything else is kept). Audio blobs are re-created from base64.
 */
export async function importAll(file: ExportFile): Promise<ImportSummary> {
  const d = await db();
  if (file.profile) {
    const cur = await loadProfile();
    await saveProfile(mergeProfiles(cur, file.profile));
  }
  const tx = d.transaction(['songs', 'attempts', 'sessions', 'exerciseResults', 'reviews', 'games', 'coachThreads', 'settings', 'recordings', 'assets'], 'readwrite');
  for (const s of file.songs) await tx.objectStore('songs').put(s);
  for (const a of file.attempts) await tx.objectStore('attempts').put(a);
  for (const s of file.sessions) await tx.objectStore('sessions').put(s);
  for (const e of file.exerciseResults) await tx.objectStore('exerciseResults').put(e);
  for (const r of file.reviews) await tx.objectStore('reviews').put({ ...r, id: `${r.songId}:${r.phraseIndex}` });
  for (const g of file.games) await tx.objectStore('games').put(g);
  for (const t of file.coachThreads) await tx.objectStore('coachThreads').put(t);
  for (const s of file.settings) {
    // a weekly plan from another browser is for the same singer: keep it only when it is not already cached
    if (s.key === 'weeklyPlan' && (await tx.objectStore('settings').get(s.key))) continue;
    await tx.objectStore('settings').put({ key: s.key, value: s.value });
  }
  for (const r of file.recordings) {
    const { blob, ...rest } = r;
    await tx.objectStore('recordings').put({ ...rest, blob: dataToBlob(blob), mime: rest.mime || blob.mime } as RecordingRecord);
  }
  for (const a of file.assets) {
    const { blob, ...rest } = a;
    await tx.objectStore('assets').put({ ...rest, blob: dataToBlob(blob), mime: rest.mime || blob.mime } as AudioAsset);
  }
  await tx.done;
  return summarize(file);
}

/** Read a picked file and parse it (does not import yet, so the UI can confirm first). */
export async function readExportFile(f: Blob): Promise<ExportFile> {
  const text = await f.text();
  return parseExport(text);
}

/** One line a person can read before confirming an import. */
export function describeSummary(s: ImportSummary): string {
  const parts = [
    `${s.songs} song${s.songs === 1 ? '' : 's'}`,
    `${s.attempts} phrase takes`,
    `${s.sessions} sessions`,
    `${s.exerciseResults} exercise reps`,
    `${s.reviews} review states`,
    `${s.games} game results`,
    `${s.coachThreads} coach chats`,
  ];
  if (s.includesAudio) parts.push(`${s.recordings} recordings and ${s.assets} audio files`);
  const when = s.exportedAt ? ` (exported ${new Date(s.exportedAt).toLocaleString()})` : '';
  return `${parts.join(', ')}${s.profile ? ', plus your profile' : ''}${when}.`;
}
