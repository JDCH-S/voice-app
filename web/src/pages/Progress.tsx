import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { listAttempts, listExerciseResults, listSessions, listSongs } from '../lib/store/db';
import type { ExerciseResult, PhraseAttempt, SessionRecord, SongRecord } from '../lib/types';
import LineChart from '../components/LineChart';
import { midiToName } from '../lib/music/notes';
import { weakestCriterion, dominantIssue } from '../lib/plan';
import { tipFor } from '../lib/scoring/score';
import { exerciseById } from '../lib/exercises/library';

const INDIGO = '#4f46e5';
const AMBER = '#d97706';

export default function Progress() {
  const { profile } = useApp();
  const [attempts, setAttempts] = useState<PhraseAttempt[]>([]);
  const [songs, setSongs] = useState<SongRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [ex, setEx] = useState<ExerciseResult[]>([]);
  const [songFilter, setSongFilter] = useState<string>('all');
  useEffect(() => {
    listAttempts().then((a) => setAttempts(a.sort((x, y) => x.date - y.date)));
    listSongs().then(setSongs);
    listSessions().then(setSessions);
    listExerciseResults().then(setEx);
  }, []);
  if (!profile) return null;

  // daily average score
  const byDay = new Map<string, number[]>();
  for (const a of attempts) {
    if (songFilter !== 'all' && a.songId !== songFilter) continue;
    const d = new Date(a.date);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    byDay.set(k, [...(byDay.get(k) ?? []), a.scores.overall]);
  }
  const trend = [...byDay.entries()].map(([k, vals]) => {
    const [y, m, d] = k.split('-').map(Number);
    return { x: new Date(y, m, d).getTime(), y: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), label: `${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)} avg of ${vals.length}` };
  });
  const pitchTrend = [...byDay.entries()].map(([k]) => {
    const [y, m, d] = k.split('-').map(Number);
    const day = new Date(y, m, d).getTime();
    const vals = attempts.filter((a) => {
      const dd = new Date(a.date);
      return `${dd.getFullYear()}-${dd.getMonth()}-${dd.getDate()}` === k && (songFilter === 'all' || a.songId === songFilter);
    });
    return { x: day, y: Math.round(vals.reduce((a, b) => a + b.scores.pitch, 0) / vals.length) };
  });
  const rangeLow = profile.rangeTests.map((r) => ({ x: r.date, y: r.lowMidi, label: midiToName(r.lowMidi) }));
  const rangeHigh = profile.rangeTests.map((r) => ({ x: r.date, y: r.highMidi, label: midiToName(r.highMidi) }));
  const weakest = weakestCriterion(attempts);
  const dom = dominantIssue(attempts.slice(-40));
  const tip = dom ? tipFor(dom) : null;

  const perSong = songs.map((s) => {
    const mine = attempts.filter((a) => a.songId === s.id);
    const best = new Map<number, PhraseAttempt>();
    for (const a of mine) {
      const b = best.get(a.phraseIndex);
      if (!b || a.scores.overall > b.scores.overall) best.set(a.phraseIndex, a);
    }
    return { song: s, attempts: mine.length, best };
  });

  const totalMin = Math.round(sessions.reduce((a, s) => a + s.activeSeconds, 0) / 60);

  return (
    <div className="col" style={{ gap: 18 }}>
      <div>
        <h1>Progress</h1>
        <p className="muted">
          {attempts.length} phrase takes · {ex.length} exercise reps · {totalMin} minutes of singing across {sessions.length} sessions.
        </p>
      </div>
      <div className="grid cols-3">
        <div className="card">
          <div className="tiny muted">Weakest area</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{weakest ? `${label(weakest.key)} (${Math.round(weakest.value)})` : '—'}</div>
          {tip && (
            <div className="small muted">
              {tip.title}. {exerciseById(tip.exerciseId) && <Link to={`/exercise/${tip.exerciseId}`}>Train: {exerciseById(tip.exerciseId)!.name}</Link>}
            </div>
          )}
        </div>
        <div className="card">
          <div className="tiny muted">Range now</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>
            {profile.rangeTests.length ? `${midiToName(profile.rangeTests.at(-1)!.lowMidi)} – ${midiToName(profile.rangeTests.at(-1)!.highMidi)}` : '—'}
          </div>
          <div className="small muted">
            {profile.rangeTests.length >= 2
              ? `${profile.rangeTests.at(-1)!.highMidi - profile.rangeTests.at(-1)!.lowMidi - (profile.rangeTests[0].highMidi - profile.rangeTests[0].lowMidi)} semitones since your first test`
              : 'Re-test every three weeks to see it move.'}
          </div>
        </div>
        <div className="card">
          <div className="tiny muted">Pitch accuracy (range test)</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{profile.rangeTests.length ? `${profile.rangeTests.at(-1)!.accuracyScore}/100` : '—'}</div>
          <div className="small muted">{profile.rangeTests.length ? `avg ${profile.rangeTests.at(-1)!.accuracyCents}¢ off the target` : ''}</div>
        </div>
      </div>
      <div className="card">
        <div className="row between">
          <h3>Phrase scores over time</h3>
          <select value={songFilter} onChange={(e) => setSongFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">All songs</option>
            {songs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
        <LineChart series={[{ name: 'Overall', color: INDIGO, points: trend }, { name: 'Pitch', color: AMBER, points: pitchTrend }]} yMin={0} yMax={100} />
      </div>
      <div className="card">
        <h3>Range over time</h3>
        <LineChart series={[{ name: 'Highest', color: INDIGO, points: rangeHigh }, { name: 'Lowest', color: AMBER, points: rangeLow }]} yFormat={(v) => midiToName(v)} />
      </div>
      <div className="card">
        <h3>Per song, per phrase (best score)</h3>
        {perSong.length === 0 && <p className="muted">No songs yet.</p>}
        {perSong.map(({ song, attempts: n, best }) => (
          <div key={song.id} style={{ marginBottom: 16 }}>
            <div className="row between">
              <Link to={`/practice/${song.id}`}>
                <b>{song.title}</b>
              </Link>
              <span className="tiny muted">{n} takes</span>
            </div>
            <div className="row" style={{ gap: 4, marginTop: 6 }}>
              {song.analysis.phrases.map((p) => {
                const b = best.get(p.index);
                const v = b?.scores.overall ?? null;
                const bg = v === null ? 'var(--panel-2)' : v >= 85 ? 'var(--good-soft)' : v >= 65 ? 'var(--near-soft)' : 'var(--bad-soft)';
                const fg = v === null ? 'var(--muted)' : v >= 85 ? 'var(--good)' : v >= 65 ? 'var(--near)' : 'var(--bad)';
                return (
                  <Link
                    key={p.index}
                    to={`/practice/${song.id}?phrase=${p.index}`}
                    title={`Phrase ${p.index + 1}: ${p.text || ''} ${v !== null ? `best ${v}` : 'not yet sung'}${b ? ` · ${b.tip.title}` : ''}`}
                    style={{ background: bg, color: fg, borderRadius: 8, padding: '6px 0', width: 44, textAlign: 'center', fontWeight: 700, fontSize: '0.85rem' }}
                  >
                    {v ?? '·'}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Sessions</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Singing</th>
              <th>Takes</th>
              <th>Average</th>
              <th>Biggest fix</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...sessions].reverse().slice(0, 15).map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.startedAt).toLocaleString()}</td>
                <td>{Math.round(s.activeSeconds / 60)} min</td>
                <td>{s.phraseAttemptIds.length}</td>
                <td>{s.recap?.avgScore ?? '—'}</td>
                <td className="small muted">{s.recap?.biggestFix.split('.')[0] ?? (s.endedAt ? '—' : 'in progress')}</td>
                <td>{s.recap && <Link to={`/recap/${s.id}`}>Recap</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function label(k: string): string {
  return k === 'pitch' ? 'Pitch' : k === 'timing' ? 'Timing' : k === 'length' ? 'Note length' : 'Expression';
}
