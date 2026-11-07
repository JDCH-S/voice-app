import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { listAttempts, listExerciseResults, listReviews, listSessions, listSongs } from '../lib/store/db';
import type { ExerciseResult, PhraseAttempt, ReviewState, SessionRecord, SongRecord, WeeklyPlan, WeeklyPlanDay } from '../lib/types';
import { buildPlan, type PlanItem } from '../lib/plan';
import { midiToName } from '../lib/music/notes';
import { describeDue, dueReviews } from '../lib/review';
import { dailyGoalMinutes, habitLine, streakDays, todayMinutes } from '../lib/habits';
import { coachPlan, coachStatus } from '../lib/api';
import { buildCoachContext, weekStartOf } from '../lib/coachContext';
import { cacheWeeklyPlan, loadCachedWeeklyPlan, normalizeWeeklyPlan, rulesWeeklyPlan } from '../lib/weeklyPlan';
import ScoreRing from '../components/ScoreRing';
import GoalRing from '../components/shell/GoalRing';
import WeekPlanCard from '../components/shell/WeekPlanCard';
import { SettingsIcon } from '../components/shell/icons';

type DayItem = WeeklyPlanDay['items'][number];

export default function Home() {
  const { profile, session, endSession, server, serverChecked } = useApp();
  const nav = useNavigate();
  const [songs, setSongs] = useState<SongRecord[]>([]);
  const [attempts, setAttempts] = useState<PhraseAttempt[]>([]);
  const [ex, setEx] = useState<ExerciseResult[]>([]);
  const [reviews, setReviews] = useState<ReviewState[]>([]);
  const [storedSessions, setStoredSessions] = useState<SessionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [week, setWeek] = useState<WeeklyPlan | null>(null);
  const [weekLoading, setWeekLoading] = useState(true);
  const [weekError, setWeekError] = useState<string | null>(null);
  const weekStarted = useRef(false);

  useEffect(() => {
    (async () => {
      const [s, a, e, r, ss] = await Promise.all([listSongs(), listAttempts(), listExerciseResults(), listReviews(), listSessions()]);
      setSongs(s);
      setAttempts(a);
      setEx(e);
      setReviews(r);
      setStoredSessions(ss);
      setLoaded(true);
    })();
  }, []);

  const now = Date.now();
  // the current session is the freshest copy of itself
  const sessions = useMemo(
    () => (storedSessions.some((s) => s.id === session.id) ? storedSessions.map((s) => (s.id === session.id ? session : s)) : [...storedSessions, session]),
    [storedSessions, session],
  );
  const plan = useMemo(() => (profile ? buildPlan(profile, attempts, ex, songs, reviews) : []), [profile, attempts, ex, songs, reviews]);

  const buildWeek = useCallback(
    async (force: boolean) => {
      if (!profile) return;
      setWeekLoading(true);
      setWeekError(null);
      const weekStart = weekStartOf(Date.now());
      try {
        if (!force) {
          const cached = await loadCachedWeeklyPlan();
          if (cached) {
            setWeek(cached);
            return;
          }
        }
        const rules = rulesWeeklyPlan(plan, weekStart);
        let result: WeeklyPlan = rules;
        if (server?.ok) {
          const st = await coachStatus();
          if (st?.available) {
            try {
              const ctx = buildCoachContext(profile, attempts, songs, sessions);
              const raw = await coachPlan({ ...ctx, weekStart });
              const normal = normalizeWeeklyPlan(raw, weekStart, songs);
              if (normal) result = normal;
              else setWeekError('The coach sent a plan in a shape the app could not read, so this is the rule-based plan.');
            } catch (e) {
              setWeekError(`The coach could not write the plan (${(e as Error).message}). This is the rule-based plan instead.`);
            }
          } else if (force) {
            setWeekError(st ? 'The coach is not set up yet (add a key on the Coach page), so this is the rule-based plan.' : 'This analysis service has no coach, so this is the rule-based plan.');
          }
        } else if (force) {
          setWeekError('The analysis service is not running, so this is the rule-based plan.');
        }
        setWeek(result);
        await cacheWeeklyPlan(result);
      } finally {
        setWeekLoading(false);
      }
    },
    [profile, plan, attempts, songs, sessions, server],
  );

  useEffect(() => {
    if (!loaded || !serverChecked || weekStarted.current) return;
    weekStarted.current = true;
    buildWeek(false);
  }, [loaded, serverChecked, buildWeek]);

  if (!profile) return null;
  const last = profile.rangeTests[profile.rangeTests.length - 1];
  const recent = attempts.slice(-10);
  const recentAvg = recent.length ? Math.round(recent.reduce((a, b) => a + b.scores.overall, 0) / recent.length) : null;
  const sessionActive = session.phraseAttemptIds.length + session.exerciseResultIds.length > 0;
  const goal = dailyGoalMinutes(profile);
  const mins = todayMinutes(sessions, now);
  const streak = streakDays(sessions, now);
  const due = dueReviews(
    reviews.filter((r) => songs.some((s) => s.id === r.songId)),
    now,
    5,
  );

  function go(item: PlanItem) {
    switch (item.kind) {
      case 'warmup':
        nav('/exercises');
        break;
      case 'exercise':
        nav(item.exerciseId ? `/exercise/${item.exerciseId}` : '/exercises');
        break;
      case 'phrase':
      case 'review':
        nav(`/practice/${item.songId}?phrase=${item.phraseIndex ?? 0}`);
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

  function openWeekItem(item: DayItem) {
    switch (item.kind) {
      case 'exercise':
        nav(item.exerciseId ? `/exercise/${item.exerciseId}` : '/exercises');
        break;
      case 'song':
        nav(item.songId ? `/practice/${item.songId}` : '/songs');
        break;
      case 'phrase':
        nav(item.songId ? `/practice/${item.songId}?phrase=${item.phraseIndex ?? 0}` : '/songs');
        break;
      case 'range-test':
        nav('/settings#range');
        break;
      case 'rest':
        break;
    }
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <h1>
            {greeting()}
            {profile.name ? `, ${profile.name}` : ''}.
          </h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            Here is today's plan, built from your range, your goals and what the songs revealed.
          </p>
        </div>
        <div className="row">
          <Link to="/settings" className="btn mobile-only" aria-label="Settings">
            <SettingsIcon size={18} /> Settings
          </Link>
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
      </div>
      <div className="grid cols-3">
        <div className="card row" style={{ gap: 16, flexWrap: 'nowrap' }}>
          <GoalRing minutes={mins} goal={goal} size={92} />
          <div className="grow">
            <div className="tiny muted">Today's goal</div>
            <div className="streak-flame">
              {streak} day{streak === 1 ? '' : 's'} <span className="small muted" style={{ fontWeight: 500 }}>in a row</span>
            </div>
            <div className="small muted">{habitLine(sessions, profile, now)}</div>
            <div className="tiny" style={{ marginTop: 4 }}>
              <Link to="/settings#habits">{profile.reminderTime ? `Reminder at ${profile.reminderTime}` : 'Set a daily reminder'}</Link>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="tiny muted">Your range</div>
          {last ? (
            <>
              <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>
                {midiToName(last.lowMidi)} – {midiToName(last.highMidi)}
              </div>
              <div className="small muted">
                {last.voiceType} · measured {Math.floor((now - last.date) / 86400000)} days ago
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
            <div className="tiny muted" style={{ marginTop: 6 }}>
              This session: {Math.round(session.activeSeconds / 60)} min · {session.phraseAttemptIds.length} takes · {session.exerciseResultIds.length} exercises
            </div>
          </div>
          {recentAvg !== null ? <ScoreRing value={recentAvg} small /> : <span className="muted">—</span>}
        </div>
      </div>
      {due.length > 0 && (
        <div className="card" data-testid="due-reviews">
          <div className="row between">
            <h2 style={{ marginBottom: 2 }}>Due today</h2>
            <span className="pill accent">{due.length} phrase{due.length === 1 ? '' : 's'} to review</span>
          </div>
          <p className="small muted">Spaced review: one good take today and the phrase stays with you for longer.</p>
          <div className="col" style={{ gap: 6 }}>
            {due.map((r) => {
              const song = songs.find((s) => s.id === r.songId)!;
              const phrase = song.analysis.phrases[r.phraseIndex];
              return (
                <button key={`${r.songId}:${r.phraseIndex}`} className="due-item" onClick={() => nav(`/practice/${r.songId}?phrase=${r.phraseIndex}`)}>
                  <span>
                    <b>{song.title}</b> · phrase {r.phraseIndex + 1}
                    {phrase?.text ? <span className="muted"> · "{phrase.text.slice(0, 40)}{phrase.text.length > 40 ? '…' : ''}"</span> : null}
                    <div className="tiny muted">{describeDue(r, now)}</div>
                  </span>
                  <span className="pill">{r.mastery}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="card">
        <h2>Practise next</h2>
        <div className="col" style={{ gap: 10 }}>
          {plan.map((item, i) => (
            <div key={i} className={`plan-item ${item.kind === 'review' ? 'review' : ''}`}>
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
      <WeekPlanCard plan={week} loading={weekLoading} error={weekError} onRefresh={() => buildWeek(true)} onOpen={openWeekItem} now={now} />
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
          <div className="small" style={{ marginTop: 10 }}>
            <Link to="/coach">Ask the coach a question →</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
