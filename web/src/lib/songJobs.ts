import type { SongRecord } from './types';
import { deleteJob, jobAnalysis, jobStatus, jobStem } from './api';
import { alignLyrics } from './analysis/lyrics';
import { saveAsset, saveSong } from './store/db';

export interface UpgradeInfo {
  status: string;
  progress: number;
  message: string;
  done: boolean;
  failed: boolean;
}

/**
 * Check a song's pending server job. When the separated analysis and stems are ready,
 * download them, store them locally and upgrade the song record. Returns the new record when upgraded.
 */
export async function checkSongJob(song: SongRecord): Promise<{ info: UpgradeInfo; song: SongRecord }> {
  if (!song.jobId) return { info: { status: 'none', progress: 1, message: '', done: true, failed: false }, song };
  let st;
  try {
    st = await jobStatus(song.jobId);
  } catch {
    // job gone (server restarted or purged): stay in fallback mode
    const updated = { ...song, jobId: null };
    await saveSong(updated);
    return { info: { status: 'lost', progress: 1, message: 'The analysis job is no longer available; staying in fallback mode.', done: true, failed: true }, song: updated };
  }
  if (st.finalReady) {
    const analysis = await jobAnalysis(song.jobId, 'final');
    const vocals = await jobStem(song.jobId, 'vocals');
    const instrumental = await jobStem(song.jobId, 'instrumental');
    await saveAsset({ id: `${song.id}:vocals`, songId: song.id, kind: 'vocals', blob: vocals.blob, mime: vocals.mime });
    await saveAsset({ id: `${song.id}:instrumental`, songId: song.id, kind: 'instrumental', blob: instrumental.blob, mime: instrumental.mime });
    alignLyrics(analysis, song.lyrics);
    const updated: SongRecord = { ...song, analysis, mode: analysis.mode, hasStems: true, jobId: null };
    await saveSong(updated);
    await deleteJob(song.jobId);
    return { info: { status: 'done', progress: 1, message: 'Isolated vocal ready.', done: true, failed: false }, song: updated };
  }
  if (st.status === 'failed') {
    const updated = { ...song, jobId: null };
    await saveSong(updated);
    await deleteJob(song.jobId);
    const reason = (st.error || '').split(':').slice(-1)[0].trim();
    return {
      info: {
        status: 'failed',
        progress: 1,
        message: `Vocal separation failed on the analysis server${reason ? ` (${reason})` : ''}. You can keep practising in fallback mode; add the song again once the server is fixed to get the isolated vocal.`,
        done: true,
        failed: true,
      },
      song: updated,
    };
  }
  return { info: { status: st.status, progress: st.progress, message: st.message, done: false, failed: false }, song };
}
