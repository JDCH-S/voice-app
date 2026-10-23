export function scoreColor(v: number): string {
  if (v >= 85) return 'var(--good)';
  if (v >= 65) return 'var(--near)';
  return 'var(--bad)';
}

export default function ScoreRing({ value, label, small }: { value: number; label?: string; small?: boolean }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="col center" style={{ gap: 4, alignItems: 'center' }}>
      <div className={`score-ring ${small ? 'sm' : ''}`}>
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--panel-2)" strokeWidth="10" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={scoreColor(v)}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${(v / 100) * c} ${c}`}
            transform="rotate(-90 50 50)"
          />
        </svg>
        <div className="val">{Math.round(v)}</div>
      </div>
      {label && <div className="tiny muted">{label}</div>}
    </div>
  );
}
