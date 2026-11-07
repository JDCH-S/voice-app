import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './lib/AppContext';
import Home from './pages/Home';
import Onboarding from './pages/Onboarding';
import Library from './pages/Library';
import ImportSong from './pages/ImportSong';
import Practice from './pages/Practice';
import Exercises from './pages/Exercises';
import ExerciseRun from './pages/ExerciseRun';
import Progress from './pages/Progress';
import Recap from './pages/Recap';
import Settings from './pages/Settings';
import Calibration from './pages/Calibration';
import Coach from './pages/Coach';
import RestBanner from './components/RestBanner';
import Sidebar from './components/shell/Sidebar';
import BottomTabs from './components/shell/BottomTabs';
import { scheduleReminder, showReminder } from './lib/notifications';
import { dailyGoalMinutes, todayMinutes } from './lib/habits';
import { listSessions } from './lib/store/db';
import './styles-app.css';

export default function App() {
  const { profile } = useApp();
  const loc = useLocation();
  const reminderTime = profile?.reminderTime ?? null;
  const goal = dailyGoalMinutes(profile);

  // daily reminder: fires while the app is open (a closed tab cannot run code)
  useEffect(() => {
    if (!reminderTime) return;
    return scheduleReminder({ reminderTime }, async () => {
      let mins = 0;
      try {
        mins = todayMinutes(await listSessions(), Date.now());
      } catch {
        /* no data */
      }
      const body = mins >= goal ? `You already sang ${Math.round(mins)} minutes today. A few more is a bonus, or rest your voice.` : mins > 0 ? `${Math.round(mins)} of ${goal} minutes done today. Warm up, then one phrase.` : `Your ${goal} minutes are waiting. Warm up first, then one phrase.`;
      showReminder('Time to sing', body);
    });
  }, [reminderTime, goal]);

  if (!profile) return <div className="main">Loading…</div>;
  const needsOnboarding = !profile.onboardingDone && !loc.pathname.startsWith('/onboarding') && !loc.pathname.startsWith('/settings');
  if (needsOnboarding) return <Navigate to="/onboarding" replace />;
  const inPractice = loc.pathname.startsWith('/practice') || loc.pathname.startsWith('/exercise/');
  return (
    <div className="app">
      <Sidebar name={profile.name} />
      <main className={`main ${inPractice ? 'wide' : ''}`}>
        <RestBanner />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/calibration" element={<Calibration />} />
          <Route path="/songs" element={<Library />} />
          <Route path="/songs/new" element={<ImportSong />} />
          <Route path="/practice/:songId" element={<Practice />} />
          <Route path="/exercises" element={<Exercises />} />
          <Route path="/exercise/:exerciseId" element={<ExerciseRun />} />
          <Route path="/coach" element={<Coach />} />
          <Route path="/progress" element={<Progress />} />
          <Route path="/recap/:sessionId" element={<Recap />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <BottomTabs />
    </div>
  );
}
