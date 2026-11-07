import { NavLink } from 'react-router-dom';
import { CoachIcon, ExercisesIcon, ProgressIcon, SettingsIcon, SongsIcon, TodayIcon } from './icons';

/** Desktop navigation (hidden under 900 px, where BottomTabs takes over). */
export default function Sidebar({ name }: { name: string }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" /> Voice Coach
      </div>
      <nav className="nav col" style={{ gap: 2 }}>
        <NavLink to="/" end>
          <TodayIcon size={18} /> Today
        </NavLink>
        <NavLink to="/songs">
          <SongsIcon size={18} /> Songs
        </NavLink>
        <NavLink to="/exercises">
          <ExercisesIcon size={18} /> Exercises
        </NavLink>
        <NavLink to="/coach">
          <CoachIcon size={18} /> Coach
        </NavLink>
        <NavLink to="/progress">
          <ProgressIcon size={18} /> Progress
        </NavLink>
        <NavLink to="/settings">
          <SettingsIcon size={18} /> Settings
        </NavLink>
      </nav>
      <div className="foot">
        {name ? `Hi ${name}. ` : ''}
        Headphones on, mic ready.
      </div>
    </aside>
  );
}
