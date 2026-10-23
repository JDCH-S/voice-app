import { useState } from 'react';

export interface Series {
  name: string;
  color: string;
  points: { x: number; y: number; label?: string }[];
}

/**
 * Small SVG line chart with a hover crosshair and tooltip. One y axis.
 * x is a timestamp (ms) or an index; y is the measured value.
 */
export default function LineChart({
  series,
  height = 220,
  yMin,
  yMax,
  yFormat = (v) => String(Math.round(v)),
  xFormat = (v) => new Date(v).toLocaleDateString(),
}: {
  series: Series[];
  height?: number;
  yMin?: number;
  yMax?: number;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = height;
  const pad = { l: 44, r: 16, t: 12, b: 28 };
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <div className="muted small">No data yet.</div>;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const lo = yMin ?? Math.min(...ys);
  const hi = yMax ?? Math.max(...ys);
  const span = hi - lo || 1;
  const X = (x: number) => pad.l + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y: number) => pad.t + (1 - (y - lo) / span) * (H - pad.t - pad.b);
  const ticks = 4;
  const hoverX = hover !== null ? x0 + ((hover - pad.l) / (W - pad.l - pad.r)) * (x1 - x0) : null;
  const nearest = (s: Series) => {
    if (hoverX === null || s.points.length === 0) return null;
    return s.points.reduce((a, b) => (Math.abs(b.x - hoverX) < Math.abs(a.x - hoverX) ? b : a));
  };
  return (
    <div className="chart col" style={{ gap: 6 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setHover(((e.clientX - r.left) / r.width) * W);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: ticks + 1 }, (_, i) => lo + (span * i) / ticks).map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={pad.l - 8} y={Y(v) + 4} fontSize="11" textAnchor="end" fill="var(--muted)">
              {yFormat(v)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 8} fontSize="11" fill="var(--muted)">
          {xFormat(x0)}
        </text>
        <text x={W - pad.r} y={H - 8} fontSize="11" textAnchor="end" fill="var(--muted)">
          {xFormat(x1)}
        </text>
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" points={s.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')} />
            {s.points.map((p, i) => (
              <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="4" fill={s.color} stroke="var(--panel)" strokeWidth="2" />
            ))}
            {s.points.length > 0 && (
              <text x={X(s.points[s.points.length - 1].x) + 6} y={Y(s.points[s.points.length - 1].y) + 4} fontSize="11" fill="var(--ink)">
                {s.name}
              </text>
            )}
          </g>
        ))}
        {hover !== null && hover >= pad.l && hover <= W - pad.r && (
          <g>
            <line x1={hover} x2={hover} y1={pad.t} y2={H - pad.b} stroke="var(--muted)" strokeDasharray="3 3" />
            {series.map((s) => {
              const p = nearest(s);
              if (!p) return null;
              return <circle key={s.name} cx={X(p.x)} cy={Y(p.y)} r="6" fill={s.color} stroke="var(--panel)" strokeWidth="2" />;
            })}
          </g>
        )}
      </svg>
      <div className="row between tiny muted">
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
        <div>
          {hover !== null &&
            series
              .map((s) => {
                const p = nearest(s);
                return p ? `${s.name}: ${p.label ?? yFormat(p.y)} (${xFormat(p.x)})` : null;
              })
              .filter(Boolean)
              .join(' · ')}
        </div>
      </div>
    </div>
  );
}
