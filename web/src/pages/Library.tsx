import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { deleteSong, listAttempts, listSongs } from '../lib/store/db';
import type { PhraseAttempt, SongRecord } from '../lib/types';
import { fmtTime, keyName } from '../lib/music/notes';
import { songDifficulty } from '../lib/songs';
import ScoreRing from '../components/ScoreRing';

export default function Library() {
  const [songs, setSongs] = useState<SongRecord[] | null>(null);
  const [attempts, setAttempts] = useState<PhraseAttempt[]>([]);
  const nav = useNavigate();
  useEffect(() => {
    listSongs().then(setSongs);
    listAttempts().then(setAttempts);
  }, []);
  if (!songs) return <div className="card">Loading…</div>;

  function bestFor(song: SongRecord): { score: number | null; learned: number } {
    const mine = attempts.filter((a) => a.songId === song.id);
    const best = new Map<number, number>();
    for (const a of mine) best.set(a.phraseIndex, Math.max(best.get(a.phraseIndex) ?? 0, a.scores.overall));
    const learned = [...best.values()].filter((v) => v >= 80).length;
    const vals = [...best.values()];
    return { score: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null, learned };
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row between">
        <h1>Your songs</h1>
        <Link to="/songs/new" className="btn primary big">
          + Add a song
        </Link>
      </div>
      {songs.length === 0 && (
        <div className="card center" style={{ padding: 50 }}>
          <h2>No songs yet</h2>
          <p className="muted">Upload an MP3 of a song you love. We will build the reference vocal line and teach it to you phrase by phrase.</p>
          <Link to="/songs/new" className="btn primary big">
            Add your first song
          </Link>
        </div>
      )}
      <div className="grid cols-2">
        {songs.map((s) => {
          const b = bestFor(s);
          return (
            <div key={s.id} className="card clickable" onClick={() => nav(`/practice/${s.id}`)}>
              <div className="row between" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <h2 style={{ marginBottom: 2 }}>{s.title}</h2>
                  <div className="muted">{s.artist || 'Unknown artist'}</div>
                  <div className="row small" style={{ marginTop: 8, gap: 6 }}>
                    <span className="pill">{fmtTime(s.duration)}</span>
                    {s.analysis.key && <span className="pill">{keyName(s.analysis.key.tonic, s.analysis.key.mode)}</span>}
                    <span className="pill">{s.analysis.phrases.length} phrases</span>
                    <span className="pill">difficulty {songDifficulty(s.analysis)}/5</span>
                    {s.mode === 'separated' ? <span className="pill good">isolated vocal</span> : <span className="pill near">fallback</span>}
                    {s.jobId && <span className="pill accent">separating…</span>}
                  </div>
                  <div className="small muted" style={{ marginTop: 8 }}>
                    {b.learned} of {s.analysis.phrases.length} phrases at 80+
                  </div>
                </div>
                {b.score !== null && <ScoreRing value={b.score} label="best avg" small />}
              </div>
              <div className="row between" style={{ marginTop: 12 }}>
                <button className="primary" onClick={() => nav(`/practice/${s.id}`)}>
                  Practise
                </button>
                <button
                  className="ghost small danger"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${s.title}" and its recordings?`)) {
                      await deleteSong(s.id);
                      setSongs(await listSongs());
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
