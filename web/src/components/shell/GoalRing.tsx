/** Daily-goal ring: minutes sung today against the goal. Indigo fill, amber when the goal is done. */
export default function GoalRing({ minutes, goal, size = 96 }: { minutes: number; goal: number; size?: number }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, goal > 0 ? minutes / goal : 0));
  const done = frac >= 1;
  return (
    <div className="goal-ring" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(minutes)} of ${goal} minutes today`}>
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--panel-2)" strokeWidth="10" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={done ? '#d97706' : '#4f46e5'}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${frac * c} ${c}`}
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dasharray 0.4s ease' }}
        />
      </svg>
      <div className="goal-ring-val">
        <b>{Math.round(minutes)}</b>
        <span>/ {goal} min</span>
      </div>
    </div>
  );
}
