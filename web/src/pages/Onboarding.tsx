import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import CalibrationWizard from '../components/CalibrationWizard';
import RangeTestWizard from '../components/RangeTestWizard';
import type { Goal, Level } from '../lib/types';

const LEVELS: { id: Level; title: string; desc: string }[] = [
  { id: 'beginner', title: 'Beginner', desc: 'I sing for fun and often drift off pitch. Teach me from the start.' },
  { id: 'intermediate', title: 'Intermediate', desc: 'I can hold a tune. I want cleaner pitch, timing and a bigger range.' },
  { id: 'advanced', title: 'Advanced', desc: 'I perform or have trained. I want precise feedback on expression and detail.' },
];
const GOALS: { id: Goal; title: string }[] = [
  { id: 'sing-songs', title: 'Sing my favourite songs well' },
  { id: 'pitch', title: 'Sing in tune' },
  { id: 'range', title: 'Reach higher (or lower) notes' },
  { id: 'technique', title: 'Better technique and breath control' },
  { id: 'confidence', title: 'Confidence to sing in front of people' },
];

export default function Onboarding() {
  const { profile, updateProfile } = useApp();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(profile?.name ?? '');
  const [level, setLevel] = useState<Level>(profile?.level ?? 'beginner');
  const [goals, setGoals] = useState<Goal[]>(profile?.goals ?? ['sing-songs']);
  const steps = ['About you', 'Microphone', 'Your range', 'Done'];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="steps">
        {steps.map((s, i) => (
          <span key={s} className={i <= step ? 'done' : ''} title={s} />
        ))}
      </div>
      {step === 0 && (
        <div className="card col fade-in" style={{ gap: 18 }}>
          <div>
            <h1>Welcome. Let's learn to sing the songs you love.</h1>
            <p className="muted">Three short steps: tell us about you, check the microphone, find your range. About three minutes.</p>
          </div>
          <label className="field" style={{ maxWidth: 360 }}>
            What should we call you?
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
          </label>
          <div>
            <h3>Where are you now?</h3>
            <div className="grid cols-3">
              {LEVELS.map((l) => (
                <div key={l.id} className={`choice ${level === l.id ? 'selected' : ''}`} onClick={() => setLevel(l.id)}>
                  <h3>{l.title}</h3>
                  <div className="small muted">{l.desc}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3>What do you want? Pick any.</h3>
            <div className="row">
              {GOALS.map((g) => (
                <button
                  key={g.id}
                  className={goals.includes(g.id) ? 'active' : ''}
                  onClick={() => setGoals((gs) => (gs.includes(g.id) ? gs.filter((x) => x !== g.id) : [...gs, g.id]))}
                >
                  {g.title}
                </button>
              ))}
            </div>
          </div>
          <div>
            <button
              className="primary big"
              onClick={async () => {
                await updateProfile({ name: name.trim(), level, goals });
                setStep(1);
              }}
            >
              Continue
            </button>
          </div>
        </div>
      )}
      {step === 1 && (
        <div className="card fade-in">
          <CalibrationWizard
            onDone={async (cal) => {
              await updateProfile({ calibration: cal });
              setStep(2);
            }}
          />
        </div>
      )}
      {step === 2 && (
        <div className="card fade-in">
          <RangeTestWizard
            onDone={async (r) => {
              await updateProfile((p) => ({ ...p, rangeTests: [...p.rangeTests, r] }));
              setStep(3);
            }}
          />
        </div>
      )}
      {step === 3 && (
        <div className="card col fade-in">
          <h1>You're set{name ? `, ${name}` : ''}.</h1>
          <p>
            Every exercise and every song key is now tailored to your range. We will suggest a range re-test every three weeks so you can see it
            grow.
          </p>
          <ul>
            <li>
              <b>Songs</b>: upload an MP3 and we build the reference vocal line to learn from.
            </li>
            <li>
              <b>Exercises</b>: a daily warm-up and drills that target what the songs reveal.
            </li>
            <li>
              <b>Progress</b>: scores per song and phrase, range over time, and what to practise next.
            </li>
          </ul>
          <div className="row">
            <button
              className="primary big"
              onClick={async () => {
                await updateProfile({ onboardingDone: true });
                nav('/songs/new');
              }}
            >
              Add my first song
            </button>
            <button
              className="big"
              onClick={async () => {
                await updateProfile({ onboardingDone: true });
                nav('/exercises');
              }}
            >
              Warm up first
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
