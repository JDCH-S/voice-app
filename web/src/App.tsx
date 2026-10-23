import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
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
import RestBanner from './components/RestBanner';

export default function App() {
  const { profile } = useApp();
  const loc = useLocation();
  if (!profile) return <div className="main">Loading…</div>;
  const needsOnboarding = !profile.onboardingDone && !loc.pathname.startsWith('/onboarding') && !loc.pathname.startsWith('/settings');
  if (needsOnboarding) return <Navigate to="/onboarding" replace />;
  const inPractice = loc.pathname.startsWith('/practice') || loc.pathname.startsWith('/exercise/');
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" /> Voice Coach
        </div>
        <nav className="nav col" style={{ gap: 2 }}>
          <NavLink to="/" end>
            Today
          </NavLink>
          <NavLink to="/songs">Songs</NavLink>
          <NavLink to="/exercises">Exercises</NavLink>
          <NavLink to="/progress">Progress</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="foot">
          {profile.name ? `Hi ${profile.name}. ` : ''}
          Headphones on, mic ready.
        </div>
      </aside>
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
          <Route path="/progress" element={<Progress />} />
          <Route path="/recap/:sessionId" element={<Recap />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
