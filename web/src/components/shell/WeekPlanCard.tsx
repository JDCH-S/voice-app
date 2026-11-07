import type { WeeklyPlan, WeeklyPlanDay } from '../../lib/types';
import { DAY_LABELS, weekdayIndex } from '../../lib/weeklyPlan';

type DayItem = WeeklyPlanDay['items'][number];

export interface WeekPlanCardProps {
  plan: WeeklyPlan | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpen: (item: DayItem) => void;
  now?: number;
}

/** "Your week": seven columns, today highlighted, every item clickable. */
export default function WeekPlanCard({ plan, loading, error, onRefresh, onOpen, now = Date.now() }: WeekPlanCardProps) {
  const today = weekdayIndex(now);
  const total = plan ? plan.days.reduce((a, d) => a + d.items.reduce((x, y) => x + y.minutes, 0), 0) : 0;
  return (
    <div className="card week-plan">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Your week</h2>
          <div className="small muted">
            {plan ? (
              <>
                <span className={`pill ${plan.source === 'coach' ? 'accent' : ''}`} style={{ marginRight: 8 }}>
                  {plan.source === 'coach' ? 'written by the coach' : 'rule-based'}
                </span>
                {total} min planned
              </>
            ) : loading ? (
              'Building your plan…'
            ) : (
              'No plan yet.'
            )}
          </div>
        </div>
        <button onClick={onRefresh} disabled={loading} className="small">
          {loading ? 'Working…' : 'Refresh plan'}
        </button>
      </div>
      {error && (
        <div className="banner warn small" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      {plan && <p className="small muted" style={{ marginTop: 10 }}>{plan.summary}</p>}
      {plan && (
        <div className="week-grid">
          {plan.days.map((d, i) => {
            const label = DAY_LABELS[i] ?? d.day;
            const isToday = i === today;
            const past = i < today;
            const mins = d.items.reduce((a, b) => a + b.minutes, 0);
            return (
              <div key={label} className={`week-day ${isToday ? 'today' : ''} ${past ? 'past' : ''}`}>
                <div className="week-day-head">
                  <b>{label}</b>
                  <span className="tiny muted">{isToday ? 'today' : mins ? `${mins} min` : 'rest'}</span>
                </div>
                {d.focus && <div className="tiny week-focus">{d.focus}</div>}
                <div className="col" style={{ gap: 4 }}>
                  {d.items.map((it, k) =>
                    it.kind === 'rest' ? (
                      <div key={k} className="week-item rest tiny">
                        {it.title}
                      </div>
                    ) : (
                      <button key={k} className="week-item" onClick={() => onOpen(it)} title={it.title}>
                        <span className="week-item-title">{it.title}</span>
                        <span className="tiny muted">{it.minutes} min</span>
                      </button>
                    ),
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
