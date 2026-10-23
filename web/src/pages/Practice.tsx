import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { getAsset, getSong, listRecordings, saveAttempt, saveRecording, saveSong } from '../lib/store/db';
import type { PitchFrame, RecordingRecord, SongRecord } from '../lib/types';
import { decodeBlob } from '../lib/audio/decode';
import { player } from '../lib/audio/Player';
import PracticeSession, { type AttemptOut } from '../components/PracticeSession';
import { checkSongJob, type UpgradeInfo } from '../lib/songJobs';
import { uid, fmtTime } from '../lib/music/notes';
import { recommendSemitones } from '../lib/songs';

export default function Practice() {
  const { songId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { profile, registerAttempt, noteActivity } = useApp();
  const [song, setSong] = useState<SongRecord | null>(null);
  const [loading, setLoading] = useState('Loading song…');
  const [hasStems, setHasStems] = useState(false);
  const [hasOriginal, setHasOriginal] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradeInfo | null>(null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [replay, setReplay] = useState<{ buffer: AudioBuffer; start: number; tempo: number; semitones: number; frames: PitchFrame[]; from: number; to: number } | null>(null);
  const [showTakes, setShowTakes] = useState(false);
  const songRef = useRef<SongRecord | null>(null);
  songRef.current = song;

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
      setRecordings(await listRecordings(s.id));
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

  const onAttempt = useCallback(
    async (a: AttemptOut) => {
      const s = songRef.current;
      if (!s) return;
      const ids: string[] = [];
      if (a.kind === 'phrase' && a.phraseIndex !== null) {
        const id = uid();
        await saveAttempt({
          id,
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
        });
        ids.push(id);
      } else if (a.perPhrase) {
        for (const p of a.perPhrase) {
          const id = uid();
          await saveAttempt({
            id,
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
          });
          ids.push(id);
        }
      }
      ids.forEach((id) => registerAttempt(id, s.id));
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
    [registerAttempt],
  );

  async function replayTake(r: RecordingRecord) {
    try {
      const buffer = await decodeBlob(r.blob);
      const s = songRef.current!;
      const to = r.kind === 'full' ? s.analysis.duration : (s.analysis.phrases[r.phraseIndex ?? 0]?.end ?? s.analysis.duration) + 0.4;
      setReplay({ buffer, start: r.startSongTime, tempo: r.tempo, semitones: r.semitones, frames: r.frames, from: r.startSongTime, to });
    } catch {
      alert('Could not decode that recording in this browser.');
    }
  }

  if (!profile) return null;
  if (!song) return <div className="card">{loading}</div>;
  const last = profile.rangeTests[profile.rangeTests.length - 1];
  const rec = recommendSemitones(song.analysis, profile);
  const initialPhrase = params.get('phrase') ? parseInt(params.get('phrase')!, 10) : 0;

  const banner =
    upgrade && !upgrade.done ? (
      <div className="banner info">
        <div className="grow">
          Separating the vocal from the band on the analysis server ({upgrade.status}
          {upgrade.progress ? `, ${Math.round(upgrade.progress * 100)}%` : ''}). You are practising in fallback mode meanwhile; the view
          upgrades automatically when the isolated vocal is ready.
        </div>
      </div>
    ) : upgrade?.failed ? (
      <div className="banner warn">{upgrade.message}</div>
    ) : song.analysis.warnings.length && song.mode === 'mix' ? (
      <div className="banner warn">
        <div className="grow">{song.analysis.warnings[0]}</div>
        <Link to="/settings" className="btn small">
          Server settings
        </Link>
      </div>
    ) : null;

  return (
    <div className="col" style={{ gap: 14 }}>
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
        <div className="card">
          <h3>Your recordings</h3>
          <p className="tiny muted">Stored only in this browser. Replay plays your voice over the song.</p>
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
                    <button className="small" onClick={() => replayTake(r)}>
                      Replay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
      />
    </div>
  );
}
