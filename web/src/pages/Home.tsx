import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { listAttempts, listExerciseResults, listSongs } from '../lib/store/db';
import type { ExerciseResult, PhraseAttempt, SongRecord } from '../lib/types';
import { buildPlan, type PlanItem } from '../lib/plan';
import { midiToName } from '../lib/music/notes';
import ScoreRing from '../components/ScoreRing';

export default function Home() {
  const { profile, session, endSession } = useApp();
  const nav = useNavigate();
  const [songs, setSongs] = useState<SongRecord[]>([]);
  const [attempts, setAttempts] = useState<PhraseAttempt[]>([]);
  const [ex, setEx] = useState<ExerciseResult[]>([]);
  useEffect(() => {
    listSongs().then(setSongs);
    listAttempts().then(setAttempts);
    listExerciseResults().then(setEx);
  }, []);
  if (!profile) return null;
  const plan = buildPlan(profile, attempts, ex, songs);
  const last = profile.rangeTests[profile.rangeTests.length - 1];
  const recent = attempts.slice(-10);
  const recentAvg = recent.length ? Math.round(recent.reduce((a, b) => a + b.scores.overall, 0) / recent.length) : null;
  const sessionActive = session.phraseAttemptIds.length + session.exerciseResultIds.length > 0;

  function go(item: PlanItem) {
    switch (item.kind) {
      case 'warmup':
        nav('/exercises');
        break;
      case 'exercise':
        nav(`/exercise/${item.exerciseId}`);
        break;
      case 'phrase':
        nav(`/practice/${item.songId}?phrase=${item.phraseIndex}`);
        break;
      case 'song':
        nav(`/practice/${item.songId}`);
        break;
      case 'range-test':
        nav('/settings#range');
        break;
      case 'import':
        nav('/songs/new');
        break;
    }
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row between">
        <div>
          <h1>{greeting()}{profile.name ? `, ${profile.name}` : ''}.</h1>
          <p className="muted">Here is today's plan, built from your range, your goals and what the songs revealed.</p>
        </div>
        {sessionActive && (
          <button
            className="big"
            onClick={async () => {
              const s = await endSession();
              nav(`/recap/${s.id}`);
            }}
          >
            End session & see recap
          </button>
        )}
      </div>
      <div className="grid cols-3">
        <div className="card">
          <div className="tiny muted">Your range</div>
          {last ? (
            <>
              <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>
                {midiToName(last.lowMidi)} – {midiToName(last.highMidi)}
              </div>
              <div className="small muted">
                {last.voiceType} · measured {Math.floor((Date.now() - last.date) / 86400000)} days ago
              </div>
            </>
          ) : (
            <Link to="/settings#range">Measure it</Link>
          )}
        </div>
        <div className="card row between">
          <div>
            <div className="tiny muted">Recent phrase scores</div>
            <div className="small muted">last {recent.length} attempts</div>
          </div>
          {recentAvg !== null ? <ScoreRing value={recentAvg} small /> : <span className="muted">—</span>}
        </div>
        <div className="card">
          <div className="tiny muted">This session</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{Math.round(session.activeSeconds / 60)} min singing</div>
          <div className="small muted">
            {session.phraseAttemptIds.length} phrase takes · {session.exerciseResultIds.length} exercises
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Practise next</h2>
        <div className="col" style={{ gap: 10 }}>
          {plan.map((item, i) => (
            <div key={i} className="row between" style={{ padding: '10px 12px', background: 'var(--panel-2)', borderRadius: 12 }}>
              <div>
                <div style={{ fontWeight: 700 }}>
                  {i + 1}. {item.title} <span className="tiny muted">· {item.minutes} min</span>
                </div>
                <div className="small muted">{item.why}</div>
              </div>
              <button className={i === 0 ? 'primary' : ''} onClick={() => go(item)}>
                Go
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h3>Songs</h3>
          {songs.length === 0 ? (
            <p className="muted">
              None yet. <Link to="/songs/new">Add one.</Link>
            </p>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {songs.slice(0, 5).map((s) => (
                <Link key={s.id} to={`/practice/${s.id}`} className="row between" style={{ color: 'inherit' }}>
                  <span>
                    <b>{s.title}</b> <span className="muted small">{s.artist}</span>
                  </span>
                  <span className="pill">{s.analysis.phrases.length} phrases</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Keep your voice healthy</h3>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Warm up before songs; never start with the high notes.</li>
            <li>If a note hurts or scratches, stop. Lower the key and come back to it.</li>
            <li>We suggest a break after 20 minutes of singing and a real rest after 40.</li>
            <li>Water, not whispering, when you are tired.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
