import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
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

interface VoiceDB extends DBSchema {
  profile: { key: string; value: Profile };
  songs: { key: string; value: SongRecord; indexes: { byCreated: number } };
  assets: { key: string; value: AudioAsset; indexes: { bySong: string } };
  attempts: { key: string; value: PhraseAttempt; indexes: { bySong: string; byDate: number } };
  recordings: { key: string; value: RecordingRecord; indexes: { bySong: string } };
  sessions: { key: string; value: SessionRecord; indexes: { byStart: number } };
  exerciseResults: { key: string; value: ExerciseResult; indexes: { byDate: number; byExercise: string } };
  settings: { key: string; value: { key: string; value: unknown } };
  games: { key: string; value: GameResult; indexes: { bySong: string; byDate: number } };
  coachThreads: { key: string; value: CoachThread; indexes: { byUpdated: number } };
  reviews: { key: string; value: ReviewState & { id: string }; indexes: { bySong: string; byDue: number } };
}

let dbp: Promise<IDBPDatabase<VoiceDB>> | null = null;

export function db(): Promise<IDBPDatabase<VoiceDB>> {
  if (!dbp) {
    dbp = openDB<VoiceDB>('voice-coach', 2, {
      upgrade(d, oldVersion) {
        if (oldVersion >= 1) {
          // v2: karaoke games, coach threads, spaced-review states
          const games = d.createObjectStore('games', { keyPath: 'id' });
          games.createIndex('bySong', 'songId');
          games.createIndex('byDate', 'date');
          const threads = d.createObjectStore('coachThreads', { keyPath: 'id' });
          threads.createIndex('byUpdated', 'updatedAt');
          const reviews = d.createObjectStore('reviews', { keyPath: 'id' });
          reviews.createIndex('bySong', 'songId');
          reviews.createIndex('byDue', 'dueAt');
          return;
        }
        d.createObjectStore('profile', { keyPath: 'id' });
        const songs = d.createObjectStore('songs', { keyPath: 'id' });
        songs.createIndex('byCreated', 'createdAt');
        const assets = d.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('bySong', 'songId');
        const attempts = d.createObjectStore('attempts', { keyPath: 'id' });
        attempts.createIndex('bySong', 'songId');
        attempts.createIndex('byDate', 'date');
        const recs = d.createObjectStore('recordings', { keyPath: 'id' });
        recs.createIndex('bySong', 'songId');
        const sessions = d.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('byStart', 'startedAt');
        const ex = d.createObjectStore('exerciseResults', { keyPath: 'id' });
        ex.createIndex('byDate', 'date');
        ex.createIndex('byExercise', 'exerciseId');
        d.createObjectStore('settings', { keyPath: 'key' });
        const games = d.createObjectStore('games', { keyPath: 'id' });
        games.createIndex('bySong', 'songId');
        games.createIndex('byDate', 'date');
        const threads = d.createObjectStore('coachThreads', { keyPath: 'id' });
        threads.createIndex('byUpdated', 'updatedAt');
        const reviews = d.createObjectStore('reviews', { keyPath: 'id' });
        reviews.createIndex('bySong', 'songId');
        reviews.createIndex('byDue', 'dueAt');
      },
    });
  }
  return dbp;
}

export const defaultProfile = (): Profile => ({
  id: 'me',
  createdAt: Date.now(),
  name: '',
  level: 'beginner',
  goals: ['sing-songs'],
  rangeTests: [],
  calibration: null,
  allowOctave: true,
  onboardingDone: false,
});

export async function loadProfile(): Promise<Profile> {
  const d = await db();
  return (await d.get('profile', 'me')) ?? defaultProfile();
}

export async function saveProfile(p: Profile): Promise<void> {
  const d = await db();
  await d.put('profile', p);
}

export async function listSongs(): Promise<SongRecord[]> {
  const d = await db();
  const all = await d.getAllFromIndex('songs', 'byCreated');
  return all.reverse();
}

export async function getSong(id: string): Promise<SongRecord | undefined> {
  const d = await db();
  return d.get('songs', id);
}

export async function saveSong(s: SongRecord): Promise<void> {
  const d = await db();
  await d.put('songs', s);
}

export async function deleteSong(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['songs', 'assets', 'attempts', 'recordings', 'games', 'reviews'], 'readwrite');
  await tx.objectStore('songs').delete(id);
  for (const store of ['assets', 'attempts', 'recordings', 'games', 'reviews'] as const) {
    const keys = await tx.objectStore(store).index('bySong').getAllKeys(id);
    for (const k of keys) await tx.objectStore(store).delete(k);
  }
  await tx.done;
}

export async function saveAsset(a: AudioAsset): Promise<void> {
  const d = await db();
  await d.put('assets', a);
}

export async function getAsset(songId: string, kind: AudioAsset['kind']): Promise<AudioAsset | undefined> {
  const d = await db();
  return d.get('assets', `${songId}:${kind}`);
}

export async function saveAttempt(a: PhraseAttempt): Promise<void> {
  const d = await db();
  await d.put('attempts', a);
}

export async function listAttempts(songId?: string): Promise<PhraseAttempt[]> {
  const d = await db();
  if (songId) return d.getAllFromIndex('attempts', 'bySong', songId);
  return d.getAllFromIndex('attempts', 'byDate');
}

export async function saveRecording(r: RecordingRecord): Promise<void> {
  const d = await db();
  await d.put('recordings', r);
}

export async function listRecordings(songId: string): Promise<RecordingRecord[]> {
  const d = await db();
  return d.getAllFromIndex('recordings', 'bySong', songId);
}

export async function getRecording(id: string): Promise<RecordingRecord | undefined> {
  const d = await db();
  return d.get('recordings', id);
}

export async function saveSession(s: SessionRecord): Promise<void> {
  const d = await db();
  await d.put('sessions', s);
}

export async function listSessions(): Promise<SessionRecord[]> {
  const d = await db();
  return d.getAllFromIndex('sessions', 'byStart');
}

export async function saveExerciseResult(r: ExerciseResult): Promise<void> {
  const d = await db();
  await d.put('exerciseResults', r);
}

export async function listExerciseResults(): Promise<ExerciseResult[]> {
  const d = await db();
  return d.getAllFromIndex('exerciseResults', 'byDate');
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const d = await db();
  const row = await d.get('settings', key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const d = await db();
  await d.put('settings', { key, value });
}

export async function saveGame(g: GameResult): Promise<void> {
  const d = await db();
  await d.put('games', g);
}

export async function listGames(songId?: string): Promise<GameResult[]> {
  const d = await db();
  if (songId) return d.getAllFromIndex('games', 'bySong', songId);
  return d.getAllFromIndex('games', 'byDate');
}

export async function saveCoachThread(t: CoachThread): Promise<void> {
  const d = await db();
  await d.put('coachThreads', t);
}

export async function listCoachThreads(): Promise<CoachThread[]> {
  const d = await db();
  return (await d.getAllFromIndex('coachThreads', 'byUpdated')).reverse();
}

export async function deleteCoachThread(id: string): Promise<void> {
  const d = await db();
  await d.delete('coachThreads', id);
}

export const reviewId = (songId: string, phraseIndex: number) => `${songId}:${phraseIndex}`;

export async function saveReview(r: ReviewState): Promise<void> {
  const d = await db();
  await d.put('reviews', { ...r, id: reviewId(r.songId, r.phraseIndex) });
}

export async function listReviews(songId?: string): Promise<ReviewState[]> {
  const d = await db();
  if (songId) return d.getAllFromIndex('reviews', 'bySong', songId);
  return d.getAllFromIndex('reviews', 'byDue');
}

export async function wipeAll(): Promise<void> {
  const d = await db();
  const stores = ['profile', 'songs', 'assets', 'attempts', 'recordings', 'sessions', 'exerciseResults', 'settings', 'games', 'coachThreads', 'reviews'] as const;
  const tx = d.transaction(stores, 'readwrite');
  for (const s of stores) await tx.objectStore(s).clear();
  await tx.done;
}
