import { useState } from 'react';
import type { CalendarCell } from '../../lib/progressStats';
import { DAY_LABELS } from '../../lib/weeklyPlan';

const INDIGO = '#4f46e5';

/** Shade of indigo for the minutes sung in a day (goal reached = full). */
function shade(minutes: number, goal: number): { background: string; color: string } {
  if (minutes <= 0) return { background: 'var(--panel-2)', color: 'var(--muted)' };
  const frac = Math.min(1, minutes / Math.max(1, goal));
  const alpha = 0.25 + 0.75 * frac;
  return { background: `rgba(79, 70, 229, ${alpha.toFixed(2)})`, color: frac >= 0.5 ? '#fff' : 'var(--ink)' };
}

/** 12-week practice calendar (rows = weeks, Monday first), with a hover tooltip. */
export default function StreakCalendar({ rows, goalMinutes }: { rows: CalendarCell[][]; goalMinutes: number }) {
  const [hover, setHover] = useState<CalendarCell | null>(null);
  const active = rows.flat().filter((c) => c.minutes > 0).length;
  const first = rows[0]?.[0];
  const last = rows[rows.length - 1]?.[6];
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="streak-cal" role="grid" aria-label="Practice calendar">
        <div className="streak-row head">
          <span className="tiny muted streak-month" />
          {DAY_LABELS.map((d) => (
            <span key={d} className="tiny muted">
              {d[0]}
            </span>
          ))}
        </div>
        {rows.map((row, i) => {
          const monday = new Date(row[0].day);
          const showMonth = i === 0 || monday.getDate() <= 7;
          return (
            <div key={row[0].key} className="streak-row" role="row">
              <span className="tiny muted streak-month">{showMonth ? monday.toLocaleDateString([], { month: 'short' }) : ''}</span>
              {row.map((c) => (
                <span
                  key={c.key}
                  role="gridcell"
                  className={`streak-cell ${c.today ? 'today' : ''} ${c.future ? 'future' : ''}`}
                  style={c.future ? undefined : shade(c.minutes, goalMinutes)}
                  onMouseEnter={() => setHover(c)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(c)}
                  onBlur={() => setHover(null)}
                  tabIndex={c.future ? -1 : 0}
                  title={`${new Date(c.day).toLocaleDateString()}: ${c.minutes ? `${c.minutes} min` : 'no singing'}`}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="row between tiny muted">
        <span>
          {first && last ? `${new Date(first.day).toLocaleDateString()} – ${new Date(last.day).toLocaleDateString()}` : ''} · {active} active days
        </span>
        <span style={{ minHeight: '1.2em' }}>
          {hover ? (
            <>
              <i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: INDIGO, marginRight: 6, verticalAlign: -1 }} />
              {new Date(hover.day).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}: {hover.minutes ? `${hover.minutes} min` : 'no singing'}
            </>
          ) : (
            'Darker = more minutes. Hover a day.'
          )}
        </span>
      </div>
    </div>
  );
}
