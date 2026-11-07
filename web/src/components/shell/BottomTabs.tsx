import { NavLink } from 'react-router-dom';
import { CoachIcon, ExercisesIcon, ProgressIcon, SongsIcon, TodayIcon } from './icons';

/** Phone navigation: a fixed bottom tab bar (shown under 900 px by styles-app.css). */
export default function BottomTabs() {
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink to="/" end>
        <TodayIcon />
        <span>Today</span>
      </NavLink>
      <NavLink to="/songs">
        <SongsIcon />
        <span>Songs</span>
      </NavLink>
      <NavLink to="/exercises">
        <ExercisesIcon />
        <span>Exercises</span>
      </NavLink>
      <NavLink to="/coach">
        <CoachIcon />
        <span>Coach</span>
      </NavLink>
      <NavLink to="/progress">
        <ProgressIcon />
        <span>Progress</span>
      </NavLink>
    </nav>
  );
}
