import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listSessions } from '../lib/store/db';
import type { SessionRecord } from '../lib/types';
import ScoreRing from '../components/ScoreRing';
import { exerciseById } from '../lib/exercises/library';

export default function Recap() {
  const { sessionId } = useParams();
  const [s, setS] = useState<SessionRecord | null>(null);
  useEffect(() => {
    listSessions().then((all) => setS(all.find((x) => x.id === sessionId) ?? null));
  }, [sessionId]);
  if (!s) return <div className="card">Loading…</div>;
  const r = s.recap;
  const ex = exerciseById(r?.exerciseId);
  return (
    <div style={{ maxWidth: 820 }} className="col">
      <div className="card col" style={{ gap: 16 }}>
        <div className="row between">
          <div>
            <h1>Session recap</h1>
            <div className="muted">
              {new Date(s.startedAt).toLocaleString()} · {Math.round(s.activeSeconds / 60)} min singing · {s.phraseAttemptIds.length} phrase takes ·{' '}
              {s.exerciseResultIds.length} exercise reps
            </div>
          </div>
          {r?.avgScore !== null && r?.avgScore !== undefined && <ScoreRing value={r.avgScore} label="average" />}
        </div>
        <div>
          <h3>What improved</h3>
          {r && r.improved.length > 0 ? (
            <ul>
              {r.improved.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No new personal bests this time. That is normal: consolidation days count.</p>
          )}
        </div>
        <div className="card flat" style={{ background: 'var(--accent-soft)', borderColor: '#c7cdfd' }}>
          <div className="tiny" style={{ color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase' }}>
            The one thing to fix next time
          </div>
          <p style={{ marginTop: 6 }}>{r?.biggestFix}</p>
          {ex && (
            <Link to={`/exercise/${ex.id}`} className="btn primary">
              Train it: {ex.name} ({ex.minutes} min)
            </Link>
          )}
        </div>
        <div className="row">
          <Link to="/" className="btn">
            Back to today
          </Link>
          <Link to="/progress" className="btn">
            See progress
          </Link>
        </div>
      </div>
    </div>
  );
}
