import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { getAsset, getSong, listAttempts, listRecordings, listReviews, reviewId, saveAttempt, saveRecording, saveReview, saveSong } from '../lib/store/db';
import type { PhraseAttempt, RecordingRecord, ReviewState, SongRecord } from '../lib/types';
import { decodeBlob } from '../lib/audio/decode';
import { player } from '../lib/audio/Player';
import PracticeSession, { type AttemptOut, type PracticeMode, type ReplayTake } from '../components/PracticeSession';
import { checkSongJob, type UpgradeInfo } from '../lib/songJobs';
import { startAnalysis } from '../lib/api';
import { uid, fmtTime } from '../lib/music/notes';
import { recommendSemitones } from '../lib/songs';
import { firstAndLatest, updateReview } from '../lib/review';

export default function Practice() {
  const { songId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { profile, registerAttempt, noteActivity, server } = useApp();
  const [song, setSong] = useState<SongRecord | null>(null);
  const [loading, setLoading] = useState('Loading song…');
  const [hasStems, setHasStems] = useState(false);
  const [hasOriginal, setHasOriginal] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradeInfo | null>(null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [priorAttempts, setPriorAttempts] = useState<PhraseAttempt[]>([]);
  const [replay, setReplay] = useState<ReplayTake | null>(null);
  const [compare, setCompare] = useState<{ first: ReplayTake; latest: ReplayTake } | null>(null);
  const [comparing, setComparing] = useState<string | null>(null); // decoding message
  const [showTakes, setShowTakes] = useState(false);
  const [isolating, setIsolating] = useState(false);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [mode, setMode] = useState<PracticeMode>('full');
  const songRef = useRef<SongRecord | null>(null);
  songRef.current = song;
  const reviewsRef = useRef<Map<string, ReviewState>>(new Map());

  const loadTracks = useCallback(async (s: SongRecord) => {
    player.clear();
    const orig = await getAsset(s.id, 'original');
    if (orig) {
      player.setTrack('original', await decodeBlob(orig.blob));
      setHasOriginal(true);
    }
    if (s.hasStems) {
      const v = await getAsset(s.id, 'vocals');
      const i = await getAsset(s.id, 'instrumental');
      if (v && i) {
        player.setTrack('vocals', await decodeBlob(v.blob));
        player.setTrack('instrumental', await decodeBlob(i.blob));
        setHasStems(true);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!songId) return;
      const s = await getSong(songId);
      if (!s) {
        nav('/songs');
        return;
      }
      setLoading('Decoding audio…');
      await loadTracks(s);
      if (cancelled) return;
      setSong(s);
      setLoading('');
      const [recs, attempts, reviews] = await Promise.all([listRecordings(s.id), listAttempts(s.id), listReviews(s.id)]);
      if (cancelled) return;
      setRecordings(recs);
      setPriorAttempts(attempts.sort((a, b) => a.date - b.date));
      reviewsRef.current = new Map(reviews.map((r) => [reviewId(r.songId, r.phraseIndex), r]));
    })();
    return () => {
      cancelled = true;
      player.clear();
    };
  }, [songId, nav, loadTracks]);

  // poll a pending separation job and upgrade the song when ready
  useEffect(() => {
    if (!song?.jobId) return;
    let stopped = false;
    const tick = async () => {
      const cur = songRef.current;
      if (!cur || !cur.jobId || stopped) return;
      try {
        const { info, song: updated } = await checkSongJob(cur);
        if (stopped) return;
        setUpgrade(info);
        if (info.done && !info.failed && updated.hasStems) {
          await loadTracks(updated);
          setSong(updated);
          return;
        }
        if (info.done) {
          setSong(updated);
          return;
        }
      } catch (e) {
        setUpgrade({ status: 'error', progress: 0, message: (e as Error).message, done: false, failed: false });
      }
      setTimeout(tick, 4000);
    };
    tick();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.jobId, song?.id]);

  /** Spaced review: every scored phrase moves its review state along (and the Home page picks up what is due). */
  const touchReview = useCallback(async (sid: string, phrase: number, score: number) => {
    const key = reviewId(sid, phrase);
    const prev = reviewsRef.current.get(key) ?? null;
    const next = updateReview(prev, score, Date.now(), { songId: sid, phraseIndex: phrase });
    reviewsRef.current.set(key, next);
    try {
      await saveReview(next);
    } catch {
      /* storage unavailable: the practice still works */
    }
  }, []);

  const onAttempt = useCallback(
    async (a: AttemptOut) => {
      const s = songRef.current;
      if (!s) return;
      const ids: string[] = [];
      const saved: PhraseAttempt[] = [];
      if (a.kind === 'phrase' && a.phraseIndex !== null) {
        const rec: PhraseAttempt = {
          id: uid(),
          songId: s.id,
          phraseIndex: a.phraseIndex,
          date: Date.now(),
          semitones: a.semitones,
          tempo: a.tempo,
          scores: a.score.scores,
          issues: a.score.issues,
          tip: a.score.tip,
          frames: a.frames,
          noteResults: a.score.noteResults,
        };
        await saveAttempt(rec);
        ids.push(rec.id);
        saved.push(rec);
        await touchReview(s.id, a.phraseIndex, a.score.scores.overall);
      } else if (a.perPhrase) {
        for (const p of a.perPhrase) {
          const rec: PhraseAttempt = {
            id: uid(),
            songId: s.id,
            phraseIndex: p.phraseIndex,
            date: Date.now(),
            semitones: a.semitones,
            tempo: a.tempo,
            scores: p.score.scores,
            issues: p.score.issues,
            tip: p.score.tip,
            frames: [],
            noteResults: p.score.noteResults,
          };
          await saveAttempt(rec);
          ids.push(rec.id);
          saved.push(rec);
          await touchReview(s.id, p.phraseIndex, p.score.scores.overall);
        }
      }
      ids.forEach((id) => registerAttempt(id, s.id));
      if (saved.length) setPriorAttempts((prev) => [...prev, ...saved]);
      if (a.recording) {
        const rec: RecordingRecord = {
          id: uid(),
          songId: s.id,
          date: Date.now(),
          kind: a.kind,
          phraseIndex: a.phraseIndex,
          blob: a.recording.blob,
          mime: a.recording.mime,
          startSongTime: a.startSongTime,
          tempo: a.tempo,
          semitones: a.semitones,
          frames: a.frames,
          scores: a.score.scores,
        };
        await saveRecording(rec);
        setRecordings((r) => [...r, rec]);
      }
      const updated = { ...s, notesPracticed: (s.notesPracticed ?? 0) + 1 };
      await saveSong(updated);
      songRef.current = updated;
    },
    [registerAttempt, touchReview],
  );

  async function toReplayTake(r: RecordingRecord, label?: string): Promise<ReplayTake> {
    const buffer = await decodeBlob(r.blob);
    const s = songRef.current!;
    const to = r.kind === 'full' ? s.analysis.duration : (s.analysis.phrases[r.phraseIndex ?? 0]?.end ?? s.analysis.duration) + 0.4;
    return { buffer, start: r.startSongTime, tempo: r.tempo, semitones: r.semitones, frames: r.frames, from: r.startSongTime, to, label };
  }

  async function replayTake(r: RecordingRecord) {
    try {
      setReplay(await toReplayTake(r));
    } catch {
      alert('Could not decode that recording in this browser.');
    }
  }

  /** Then vs now: the first and the latest take of the current phrase (or of full runs), back to back. */
  async function compareFirstAndLatest(target: number | null) {
    const pair = firstAndLatest(recordings, target);
    if (!pair || pair.count < 2) return;
    setComparing('Decoding your two takes…');
    try {
      const when = (r: RecordingRecord) => new Date(r.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const first = await toReplayTake(pair.first, `Then: ${when(pair.first)}, scored ${pair.first.scores.overall}.`);
      const latest = await toReplayTake(pair.latest, `Now: ${when(pair.latest)}, scored ${pair.latest.scores.overall}.`);
      setCompare({ first, latest });
    } catch {
      alert('Could not decode those recordings in this browser.');
    } finally {
      setComparing(null);
    }
  }

  async function isolateVocal() {
    const s = songRef.current;
    if (!s) return;
    setIsolating(true);
    try {
      const orig = await getAsset(s.id, 'original');
      if (!orig) throw new Error('the original audio of this song is missing; add the song again');
      const jobId = await startAnalysis(orig.blob, `${s.title || 'song'}.mp3`, true);
      const updated = { ...s, jobId };
      await saveSong(updated);
      setUpgrade({ status: 'queued', progress: 0, message: '', done: false, failed: false });
      setSong(updated);
    } catch (e) {
      setUpgrade({ status: 'failed', progress: 1, message: `Could not start vocal isolation: ${(e as Error).message}`, done: true, failed: true });
    } finally {
      setIsolating(false);
    }
  }

  if (!profile) return null;
  if (!song) return <div className="card">{loading}</div>;
  const last = profile.rangeTests[profile.rangeTests.length - 1];
  const rec = recommendSemitones(song.analysis, profile);
  const initialPhrase = params.get('phrase') ? parseInt(params.get('phrase')!, 10) : 0;
  const compareTarget: number | null = mode === 'phrase' ? phraseIndex : null;
  const comparePair = firstAndLatest(recordings, compareTarget);
  const canCompare = !!comparePair && comparePair.count >= 2 && !compare;
  const compareLabel = compareTarget === null ? 'full runs' : `phrase ${compareTarget + 1}`;

  const banner =
    upgrade && !upgrade.done ? (
      <div className="banner info">
        <div className="grow">
          Separating the vocal from the band on the analysis server ({upgrade.status}
          {upgrade.progress ? `, ${Math.round(upgrade.progress * 100)}%` : ''}). You are practising in fallback mode meanwhile; the view
          upgrades automatically when the isolated vocal is ready.
          {upgrade.message && /words/i.test(upgrade.message) ? ` ${upgrade.message}` : ''}
        </div>
      </div>
    ) : upgrade?.failed ? (
      <div className="banner warn">{upgrade.message}</div>
    ) : song.mode === 'mix' && server?.ok && server.separation === 'demucs' ? (
      <div className="banner info">
        <div className="grow">
          This song was analysed from the full mix, so some bars may be off. Isolate the singer's voice for accurate notes and the vocal-only
          and band-only tracks. It takes a few minutes; you can keep singing meanwhile.
        </div>
        <button className="primary" onClick={isolateVocal} disabled={isolating}>
          {isolating ? 'Starting…' : 'Isolate the vocal'}
        </button>
      </div>
    ) : song.analysis.warnings.length && song.mode === 'mix' ? (
      <div className="banner warn">
        <div className="grow">{song.analysis.warnings[0]}</div>
        <Link to="/settings" className="btn small">
          Server settings
        </Link>
      </div>
    ) : null;

  return (
    <div className="col practice-page" style={{ gap: 14 }}>
      <div className="row between">
        <Link to="/songs" className="small">
          ← All songs
        </Link>
        <div className="row">
          {recordings.length > 0 && (
            <button className="small" onClick={() => setShowTakes((v) => !v)}>
              My takes ({recordings.length})
            </button>
          )}
        </div>
      </div>
      {showTakes && (
        <div className="card takes-panel">
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div>
              <h3>Your recordings</h3>
              <p className="tiny muted">Stored only in this browser. Replay plays your voice over the song.</p>
            </div>
            <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
              <button className="small compare-btn" disabled={!canCompare || !!comparing} onClick={() => compareFirstAndLatest(compareTarget)} title="Then vs now: your first take, then your latest, each with its trail on the roll">
                {comparing ? comparing : `Compare first and latest (${compareLabel})`}
              </button>
              {!canCompare && !compare && (
                <span className="tiny muted">
                  {comparePair && comparePair.count >= 2 ? '' : `Record two takes of ${compareLabel} to compare then and now.`}
                </span>
              )}
            </div>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Score</th>
                  <th>Key / speed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {[...recordings].reverse().map((r) => (
                  <tr key={r.id}>
                    <td className="small">{new Date(r.date).toLocaleString()}</td>
                    <td>{r.kind === 'full' ? 'Full run' : `Phrase ${(r.phraseIndex ?? 0) + 1} (${fmtTime(r.startSongTime)})`}</td>
                    <td>
                      <b>{r.scores.overall}</b>
                    </td>
                    <td className="small">
                      {r.semitones === 0 ? 'original' : `${r.semitones > 0 ? '+' : ''}${r.semitones}`} · {Math.round(r.tempo * 100)}%
                    </td>
                    <td>
                      <button className="small" onClick={() => replayTake(r)} disabled={!!compare}>
                        Replay
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <PracticeSession
        key={`${song.id}:${song.mode}:${hasStems}`}
        analysis={song.analysis}
        title={song.title}
        subtitle={song.artist}
        hasStems={hasStems}
        hasOriginal={hasOriginal}
        level={profile.level}
        allowOctave={profile.allowOctave}
        semitones={song.preferredSemitones}
        onSemitones={async (k) => {
          const updated = { ...songRef.current!, preferredSemitones: k };
          await saveSong(updated);
          setSong(updated);
        }}
        recommendedSemitones={rec.semitones}
        recommendReason={rec.reason}
        latencyMs={profile.calibration?.latencyMs ?? 45}
        highMidi={last?.highMidi ?? null}
        onAttempt={onAttempt}
        onActivity={noteActivity}
        initialPhrase={initialPhrase}
        banner={banner}
        replayRequest={replay}
        onReplayDone={() => setReplay(null)}
        compareRequest={compare}
        onCompareDone={() => setCompare(null)}
        songId={song.id}
        words={song.words ?? null}
        priorAttempts={priorAttempts}
        onPhraseChange={setPhraseIndex}
        onModeChange={setMode}
      />
    </div>
  );
}
