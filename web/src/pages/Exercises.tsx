import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { EXERCISES, warmupFor, type ExerciseCategory } from '../lib/exercises/library';
import { listExerciseResults } from '../lib/store/db';
import type { ExerciseResult } from '../lib/types';

const CATS: { id: ExerciseCategory; name: string }[] = [
  { id: 'breathing', name: 'Breathing' },
  { id: 'pitch', name: 'Pitch' },
  { id: 'range', name: 'Range & registers' },
  { id: 'tone', name: 'Tone & sustain' },
  { id: 'rhythm', name: 'Rhythm' },
  { id: 'expression', name: 'Expression' },
];

export default function Exercises() {
  const { profile } = useApp();
  const [results, setResults] = useState<ExerciseResult[]>([]);
  useEffect(() => {
    listExerciseResults().then(setResults);
  }, []);
  if (!profile) return null;
  const warm = warmupFor(profile.level, profile.goals);
  const lastFor = (id: string) => [...results].reverse().find((r) => r.exerciseId === id);
  return (
    <div className="col" style={{ gap: 18 }}>
      <div>
        <h1>Exercises</h1>
        <p className="muted">Tailored to your {profile.level} level and your range. Start with the warm-up every day.</p>
      </div>
      <div className="card" style={{ background: 'linear-gradient(135deg, #eef2ff, #fdf4ff)' }}>
        <div className="row between">
          <div>
            <h2>Today's warm-up · {warm.reduce((a, b) => a + b.minutes, 0)} min</h2>
            <div className="row" style={{ gap: 6 }}>
              {warm.map((w, i) => (
                <Link key={w.id} to={`/exercise/${w.id}?warmup=${i}`} className="pill accent">
                  {i + 1}. {w.name}
                </Link>
              ))}
            </div>
          </div>
          <Link to={`/exercise/${warm[0].id}?warmup=0`} className="btn primary big">
            Start warm-up
          </Link>
        </div>
      </div>
      {CATS.map((c) => (
        <div key={c.id}>
          <h3>{c.name}</h3>
          <div className="grid cols-3">
            {EXERCISES.filter((e) => e.category === c.id).map((e) => {
              const last = lastFor(e.id);
              return (
                <Link key={e.id} to={`/exercise/${e.id}`} className="card clickable col" style={{ color: 'inherit', gap: 6 }}>
                  <div className="row between">
                    <b>{e.name}</b>
                    <span className="tiny muted">{e.minutes} min</span>
                  </div>
                  <div className="small muted">{e.summary}</div>
                  <div className="row" style={{ gap: 4 }}>
                    {e.trains.map((t) => (
                      <span key={t} className="pill">
                        {t}
                      </span>
                    ))}
                  </div>
                  {last && (
                    <div className="tiny muted">
                      Last: {last.score}/100 · {new Date(last.date).toLocaleDateString()}
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
