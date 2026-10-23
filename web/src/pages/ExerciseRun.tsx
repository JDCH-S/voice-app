import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { exerciseById, warmupFor, type ExercisePlan } from '../lib/exercises/library';
import PracticeSession, { type AttemptOut } from '../components/PracticeSession';
import { saveExerciseResult } from '../lib/store/db';
import { uid, mean } from '../lib/music/notes';
import { mic } from '../lib/audio/MicAnalyzer';
import { useMicPitch } from '../lib/useMic';
import ScoreRing from '../components/ScoreRing';

export default function ExerciseRun() {
  const { exerciseId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { profile, registerExercise, noteActivity } = useApp();
  const ex = exerciseById(exerciseId);
  const plan = useMemo(() => (ex && profile ? ex.build(profile) : null), [ex, profile]);
  const [scores, setScores] = useState<number[]>([]);
  const [saved, setSaved] = useState(false);
  const warmIdx = params.get('warmup') !== null ? parseInt(params.get('warmup')!, 10) : null;
  const warm = profile ? warmupFor(profile.level, profile.goals) : [];
  const next = warmIdx !== null && warmIdx + 1 < warm.length ? warm[warmIdx + 1] : null;

  if (!ex || !plan || !profile) return <div className="card">Unknown exercise.</div>;

  async function finish(score: number, metrics: Record<string, number>, notes: string) {
    if (saved) return;
    const r = { id: uid(), exerciseId: ex!.id, date: Date.now(), score: Math.round(score), metrics, notes };
    await saveExerciseResult(r);
    registerExercise(r.id);
    setSaved(true);
  }

  const header = (
    <div className="row between">
      <Link to="/exercises" className="small">
        ← Exercises
      </Link>
      {next && (
        <Link to={`/exercise/${next.id}?warmup=${(warmIdx ?? 0) + 1}`} className="btn">
          Next in warm-up: {next.name} →
        </Link>
      )}
    </div>
  );

  return (
    <div className="col" style={{ gap: 14 }}>
      {header}
      <div className="card flat row" style={{ gap: 24 }}>
        <div className="grow">
          <h2 style={{ marginBottom: 4 }}>{ex.name}</h2>
          <div className="muted small">{ex.summary}</div>
        </div>
        <ol className="small" style={{ margin: 0, paddingLeft: 18, maxWidth: 420 }}>
          {ex.how.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ol>
      </div>
      {plan.kind === 'pitched' && (
        <PracticeSession
          analysis={plan.analysis}
          title={ex.name}
          hasStems={false}
          hasOriginal={false}
          level={profile.level}
          allowOctave={false}
          semitones={0}
          latencyMs={profile.calibration?.latencyMs ?? 45}
          highMidi={profile.rangeTests[profile.rangeTests.length - 1]?.highMidi ?? null}
          exercise={{ cue: plan.cue, guideGain: plan.guideGain }}
          onActivity={noteActivity}
          onAttempt={async (a: AttemptOut) => {
            const s = [...scores, a.score.scores.overall];
            setScores(s);
            const rid = uid();
            await saveExerciseResult({
              id: rid,
              exerciseId: ex.id,
              date: Date.now(),
              score: a.score.scores.overall,
              metrics: { pitch: a.score.scores.pitch, timing: a.score.scores.timing, length: a.score.scores.length, expression: a.score.scores.expression, rep: (a.phraseIndex ?? 0) + 1 },
              notes: a.score.tip.title,
            });
            registerExercise(rid);
          }}
        />
      )}
      {plan.kind === 'breathing' && <Breathing plan={plan} onDone={() => finish(100, { rounds: plan.rounds }, 'completed')} saved={saved} />}
      {plan.kind === 'hiss' && <Hiss plan={plan} onDone={(sec, even) => finish(Math.min(100, (sec / plan.targetSeconds) * 70 + even * 30), { seconds: sec, evenness: even }, `${sec.toFixed(1)} s`)} saved={saved} />}
      {scores.length > 0 && plan.kind === 'pitched' && (
        <div className="card row between">
          <div>
            <b>{scores.length} reps scored</b>
            <div className="small muted">Average {Math.round(mean(scores))}. Each rep is saved to your progress.</div>
          </div>
          <div className="row">
            <ScoreRing value={mean(scores)} small />
            {next ? (
              <button className="primary" onClick={() => nav(`/exercise/${next.id}?warmup=${(warmIdx ?? 0) + 1}`)}>
                Next: {next.name}
              </button>
            ) : (
              <button onClick={() => nav('/exercises')}>Done</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Breathing({ plan, onDone, saved }: { plan: Extract<ExercisePlan, { kind: 'breathing' }>; onDone: () => void; saved: boolean }) {
  const [running, setRunning] = useState(false);
  const [round, setRound] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const [left, setLeft] = useState(0);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (!running) return;
    let r = 0;
    let s = 0;
    let remaining = plan.steps[0].seconds;
    setRound(0);
    setStepIdx(0);
    setLeft(remaining);
    const iv = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        s++;
        if (s >= plan.steps.length) {
          s = 0;
          r++;
          if (r >= plan.rounds) {
            clearInterval(iv);
            setRunning(false);
            setFinished(true);
            onDone();
            return;
          }
        }
        remaining = plan.steps[s].seconds;
        setRound(r);
        setStepIdx(s);
      }
      setLeft(remaining);
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  const step = plan.steps[stepIdx];
  const scale = step.label.toLowerCase().includes('in') && !step.label.toLowerCase().includes('out') ? 1.25 : step.label.toLowerCase().includes('hold') ? 1.25 : 0.8;
  return (
    <div className="card center col" style={{ alignItems: 'center' }}>
      <p className="muted">{plan.cue}</p>
      <div className="breath-circle" style={{ transform: `scale(${running ? scale : 1})`, transitionDuration: running ? `${step.seconds}s` : '0.3s' }}>
        {running ? `${step.label} · ${left}` : finished ? 'Done' : 'Ready'}
      </div>
      <div className="muted small">
        Round {Math.min(round + 1, plan.rounds)} of {plan.rounds} · {plan.steps.map((s) => `${s.label} ${s.seconds}s`).join(' · ')}
      </div>
      {!running && !finished && (
        <button className="primary big" onClick={() => setRunning(true)}>
          Start
        </button>
      )}
      {finished && <div className="banner good">Nice. {saved ? 'Saved.' : ''} Your support is switched on; go sing.</div>}
    </div>
  );
}

function Hiss({ plan, onDone, saved }: { plan: Extract<ExercisePlan, { kind: 'hiss' }>; onDone: (seconds: number, evenness: number) => void; saved: boolean }) {
  const { frame } = useMicPitch(true);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<{ seconds: number; evenness: number } | null>(null);
  const start = useRef<number | null>(null);
  const dbs = useRef<number[]>([]);
  const silentSince = useRef<number | null>(null);
  useEffect(() => {
    if (!running) return;
    start.current = null;
    dbs.current = [];
    const unsub = mic.subscribe((f) => {
      const now = performance.now();
      const loud = f.db > mic.gate * 0 + -45 && f.rms > mic.gate * 1.5;
      if (loud) {
        if (start.current === null) start.current = now;
        silentSince.current = null;
        dbs.current.push(f.db);
        setSeconds((now - start.current) / 1000);
      } else if (start.current !== null) {
        if (silentSince.current === null) silentSince.current = now;
        else if (now - silentSince.current > 600) {
          const total = (silentSince.current - start.current) / 1000;
          const arr = dbs.current;
          const m = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
          const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, arr.length));
          const evenness = Math.max(0, Math.min(1, 1 - (sd - 2) / 8));
          setResult({ seconds: total, evenness });
          setRunning(false);
          onDone(total, evenness);
        }
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  const level = frame ? Math.max(0, Math.min(1, (frame.db + 60) / 55)) : 0;
  return (
    <div className="card col center" style={{ alignItems: 'center' }}>
      <p className="muted">{plan.cue}</p>
      <div className="big-note">{seconds.toFixed(1)} s</div>
      <div className="muted small">target {plan.targetSeconds} s</div>
      <div className="bar" style={{ width: 400 }}>
        <span style={{ width: `${Math.min(100, (seconds / plan.targetSeconds) * 100)}%` }} />
      </div>
      <div className="bar" style={{ width: 400 }} title="input level">
        <span style={{ width: `${level * 100}%`, background: 'var(--muted)' }} />
      </div>
      {!running && (
        <button
          className="primary big"
          onClick={() => {
            setSeconds(0);
            setResult(null);
            setRunning(true);
          }}
        >
          {result ? 'Again' : 'Start, then hiss'}
        </button>
      )}
      {running && <div className="pill good">Hissing… stop when you run out</div>}
      {result && (
        <div className="banner good">
          {result.seconds.toFixed(1)} seconds, evenness {Math.round(result.evenness * 100)}%. {result.seconds >= plan.targetSeconds ? 'Target reached.' : 'Keep the stream thinner to last longer.'}{' '}
          {saved ? 'Saved.' : ''}
        </div>
      )}
    </div>
  );
}
