import { Link } from 'react-router-dom';
import type { CriterionScore, NoteIssue, Tip } from '../lib/types';
import ScoreRing, { scoreColor } from './ScoreRing';
import { exerciseById } from '../lib/exercises/library';

const KIND_COLOR: Record<string, string> = {
  sharp: 'var(--near)',
  flat: 'var(--near)',
  missed: 'var(--bad)',
  octave: '#38bdf8',
  late: '#a855f7',
  early: '#a855f7',
  short: '#f97316',
  long: '#f97316',
  unstable: 'var(--near)',
  'no-slide': '#06b6d4',
  'no-vibrato': '#06b6d4',
  'too-soft': '#64748b',
  'too-loud': '#64748b',
  'no-breath': '#0ea5e9',
  'broke-line': '#0ea5e9',
  strain: 'var(--bad)',
};

export default function FeedbackPanel({
  scores,
  issues,
  tip,
  title,
  onRetry,
  onNext,
  onReplay,
  compact,
}: {
  scores: CriterionScore;
  issues: NoteIssue[];
  tip: Tip;
  title?: string;
  onRetry?: () => void;
  onNext?: () => void;
  onReplay?: () => void;
  compact?: boolean;
}) {
  const ex = exerciseById(tip.exerciseId);
  const bars: { k: keyof CriterionScore; label: string }[] = [
    { k: 'pitch', label: 'Pitch' },
    { k: 'timing', label: 'Timing' },
    { k: 'length', label: 'Note length' },
    { k: 'expression', label: 'Expression' },
  ];
  return (
    <div className="col fade-in" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 18 }}>
        <ScoreRing value={scores.overall} label={title ?? 'this take'} />
        <div className="col grow" style={{ gap: 6 }}>
          {bars.map((b) => (
            <div key={b.k} className="row" style={{ gap: 8 }}>
              <span className="tiny muted" style={{ width: 86 }}>
                {b.label}
              </span>
              <div className="bar grow">
                <span style={{ width: `${scores[b.k]}%`, background: scoreColor(scores[b.k]) }} />
              </div>
              <span className="tiny" style={{ width: 28, textAlign: 'right' }}>
                {scores[b.k]}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="card flat" style={{ background: 'var(--accent-soft)', borderColor: '#c7cdfd', padding: 14 }}>
        <div className="tiny" style={{ color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          One thing to change
        </div>
        <h3 style={{ marginTop: 4 }}>{tip.title}</h3>
        <p className="small" style={{ margin: 0 }}>
          {tip.detail}
        </p>
        {ex && (
          <div style={{ marginTop: 8 }}>
            <Link to={`/exercise/${ex.id}`} className="btn small">
              Train it: {ex.name} ({ex.minutes} min)
            </Link>
          </div>
        )}
      </div>
      {issues.length > 0 && (
        <div>
          <div className="tiny muted" style={{ marginBottom: 6 }}>
            Where it went off
          </div>
          <ul className="issue-list">
            {issues.slice(0, compact ? 4 : 7).map((i, idx) => (
              <li key={idx}>
                <span className="dot" style={{ background: KIND_COLOR[i.kind] ?? 'var(--muted)' }} />
                <span>{i.text}</span>
              </li>
            ))}
            {issues.length > (compact ? 4 : 7) && <li className="muted">…and {issues.length - (compact ? 4 : 7)} more</li>}
          </ul>
        </div>
      )}
      {(onRetry || onNext || onReplay) && (
        <div className="row">
          {onRetry && (
            <button className="primary" onClick={onRetry}>
              Sing it again
            </button>
          )}
          {onReplay && <button onClick={onReplay}>Replay my take</button>}
          {onNext && <button onClick={onNext}>Next phrase</button>}
        </div>
      )}
    </div>
  );
}
