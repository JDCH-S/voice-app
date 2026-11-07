import type { SongAnalysis, SongRecord, WordTiming } from './types';
import { alignLyricsOnServer, deleteJob, jobAnalysis, jobStatus, jobStem, jobWords, type JobStatus } from './api';
import { alignLyrics, alignWords } from './analysis/lyrics';
import { saveAsset, saveSong } from './store/db';

export interface UpgradeInfo {
  status: string;
  progress: number;
  message: string;
  done: boolean;
  failed: boolean;
}

/** Job status with the optional word-timing flag newer servers report. */
type JobStatusWithWords = JobStatus & { wordsReady?: boolean };

/**
 * Word timing for a finished job: the final analysis may carry it inline, otherwise the words
 * endpoint is asked (null when the server has no speech model or nothing is ready).
 */
async function fetchWords(jobId: string, analysis: SongAnalysis & { words?: WordTiming[] | null }): Promise<WordTiming[] | null> {
  const inline = analysis.words;
  if (Array.isArray(inline) && inline.length > 0) return inline;
  try {
    const w = await jobWords(jobId);
    return w && w.length > 0 ? w : null;
  } catch {
    return null;
  }
}

/**
 * Apply recognised words to a song's analysis. When the user typed or fetched lyrics, the server
 * aligns their own text to the recognised timing (keeping their spelling); otherwise the
 * recognised words are used as they are. Without words, the line-based aligner runs.
 * Returns the words that were applied (null when none).
 */
export async function applyWords(song: SongRecord, analysis: SongAnalysis, words: WordTiming[] | null, jobId: string | null): Promise<WordTiming[] | null> {
  if (!words || words.length === 0) {
    alignLyrics(analysis, song.lyrics);
    return null;
  }
  let finalWords = words;
  const ownText = song.lyrics.lines.map((l) => l.text).join('\n').trim();
  if (jobId && ownText) {
    try {
      const aligned = await alignLyricsOnServer(jobId, ownText);
      if (aligned && aligned.length > 0) finalWords = aligned;
    } catch {
      /* keep the recognised words */
    }
  }
  alignWords(analysis, finalWords, song.lyrics);
  return finalWords;
}

/**
 * Check a song's pending server job. When the separated analysis and stems are ready,
 * download them, store them locally and upgrade the song record. Returns the new record when upgraded.
 */
export async function checkSongJob(song: SongRecord): Promise<{ info: UpgradeInfo; song: SongRecord }> {
  if (!song.jobId) return { info: { status: 'none', progress: 1, message: '', done: true, failed: false }, song };
  let st: JobStatusWithWords;
  try {
    st = (await jobStatus(song.jobId)) as JobStatusWithWords;
  } catch {
    // job gone (server restarted or purged): stay in fallback mode
    const updated = { ...song, jobId: null };
    await saveSong(updated);
    return { info: { status: 'lost', progress: 1, message: 'The analysis job is no longer available; staying in fallback mode.', done: true, failed: true }, song: updated };
  }
  if (st.finalReady) {
    // the server may still be recognising the words right after the stems are ready: give it a moment
    if (st.wordsReady === false && st.status !== 'done' && st.status !== 'failed') {
      return { info: { status: st.status, progress: Math.max(st.progress, 0.95), message: 'Isolated vocal ready. Finding the words…', done: false, failed: false }, song };
    }
    const analysis = (await jobAnalysis(song.jobId, 'final')) as SongAnalysis & { words?: WordTiming[] | null };
    const vocals = await jobStem(song.jobId, 'vocals');
    const instrumental = await jobStem(song.jobId, 'instrumental');
    await saveAsset({ id: `${song.id}:vocals`, songId: song.id, kind: 'vocals', blob: vocals.blob, mime: vocals.mime });
    await saveAsset({ id: `${song.id}:instrumental`, songId: song.id, kind: 'instrumental', blob: instrumental.blob, mime: instrumental.mime });
    const words = await fetchWords(song.jobId, analysis);
    delete analysis.words;
    const finalWords = await applyWords(song, analysis, words, song.jobId);
    const updated: SongRecord = { ...song, analysis, mode: analysis.mode, hasStems: true, jobId: null, words: finalWords };
    await saveSong(updated);
    await deleteJob(song.jobId);
    return {
      info: { status: 'done', progress: 1, message: finalWords ? 'Isolated vocal and word timing ready.' : 'Isolated vocal ready.', done: true, failed: false },
      song: updated,
    };
  }
  if (st.status === 'failed') {
    const updated = { ...song, jobId: null };
    await saveSong(updated);
    await deleteJob(song.jobId);
    const reason = (st.error || '').split(':').slice(-1)[0].replace(/[<>]/g, '').trim();
    return {
      info: {
        status: 'failed',
        progress: 1,
        message: `Vocal separation failed on the analysis server${reason ? ` (${reason})` : ''}. You can keep practising in fallback mode, and try again later with the "Isolate the vocal" button. The first isolation needs an internet connection to download the separation model once.`,
        done: true,
        failed: true,
      },
      song: updated,
    };
  }
  return { info: { status: st.status, progress: st.progress, message: st.message, done: false, failed: false }, song };
}
