import { Link } from 'react-router-dom';
import type { CriterionScore, IssueKind, NoteIssue, Tip } from '../lib/types';
import ScoreRing, { scoreColor } from './ScoreRing';
import { exerciseById, exerciseForIssue } from '../lib/exercises/library';
import { describeTechnique, TECHNIQUE_KINDS, type TechniqueKind, type TechniqueSummary } from '../lib/scoring/technique';

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
  breathy: '#0891b2',
  crack: '#db2777',
  'out-of-air': '#2563eb',
};

const TECH_LABEL: Record<TechniqueKind, string> = { strain: 'pushed', breathy: 'breathy', crack: 'cracked', 'out-of-air': 'out of air' };

const isTechnique = (k: IssueKind): k is TechniqueKind => (TECHNIQUE_KINDS as IssueKind[]).includes(k);

/** The technique problem that stands out most in a summary ("pushed", "breathy", …), or null. */
export function worstTechnique(s: TechniqueSummary | undefined | null): { kind: TechniqueKind; label: string; count: number } | null {
  if (!s) return null;
  let best: TechniqueKind | null = null;
  let bestSev = 0;
  for (const k of TECHNIQUE_KINDS) {
    const sev = s.severity[k] + s.counts[k] * 0.01;
    if (s.counts[k] > 0 && sev > bestSev) {
      best = k;
      bestSev = sev;
    }
  }
  return best ? { kind: best, label: TECH_LABEL[best], count: s.counts[best] } : null;
}

export default function FeedbackPanel({
  scores,
  issues,
  tip,
  title,
  technique,
  onRetry,
  onNext,
  onReplay,
  compact,
}: {
  scores: CriterionScore;
  issues: NoteIssue[];
  tip: Tip;
  title?: string;
  technique?: TechniqueSummary | null;
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
  const limit = compact ? 4 : 7;
  const techLine = technique ? describeTechnique(technique) : null;
  const techChecked = technique && technique.notesChecked > 0;
  const techFieldsMissing = technique && !technique.fields.breathiness && !technique.fields.pressed;
  // one exercise link per technique kind that appears in the issues (the main tip already links its own)
  const techLinks: { kind: TechniqueKind; name: string; id: string }[] = [];
  for (const i of issues) {
    if (!isTechnique(i.kind) || techLinks.some((t) => t.kind === i.kind)) continue;
    const e = exerciseForIssue(i.kind);
    if (e && e.id !== tip.exerciseId) techLinks.push({ kind: i.kind, name: e.name, id: e.id });
  }
  return (
    <div className="col fade-in feedback" style={{ gap: 14 }}>
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
          {technique && (
            <div className="row" style={{ gap: 8 }} title={techFieldsMissing ? 'Only cracks and running out of air can be checked: this browser does not measure breathiness or strain' : undefined}>
              <span className="tiny muted" style={{ width: 86 }}>
                Technique
              </span>
              <div className="bar grow">
                <span style={{ width: `${technique.score}%`, background: techChecked ? scoreColor(technique.score) : 'var(--line)' }} />
              </div>
              <span className="tiny" style={{ width: 28, textAlign: 'right' }}>
                {techChecked ? technique.score : '–'}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="card flat tip-card" style={{ background: 'var(--accent-soft)', borderColor: '#c7cdfd', padding: 14 }}>
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
      {(techLine || (techChecked && !techLine)) && (
        <div className={`tech-line small ${techLine ? 'flagged' : 'clean'}`}>
          {techLine ?? `Technique: nothing wrong that we could hear on ${technique!.notesChecked} ${technique!.notesChecked === 1 ? 'note' : 'notes'}.`}
          {techFieldsMissing && techLine && <span className="tiny muted"> (breathiness and strain are not measured in this browser)</span>}
        </div>
      )}
      {issues.length > 0 && (
        <div>
          <div className="tiny muted" style={{ marginBottom: 6 }}>
            Where it went off
          </div>
          <ul className="issue-list">
            {issues.slice(0, limit).map((i, idx) => (
              <li key={idx} className={isTechnique(i.kind) ? 'technique' : ''}>
                <span className="dot" style={{ background: KIND_COLOR[i.kind] ?? 'var(--muted)' }} />
                <span>
                  {i.text}
                  {isTechnique(i.kind) && <span className="pill tiny tech-pill">{TECH_LABEL[i.kind]}</span>}
                </span>
              </li>
            ))}
            {issues.length > limit && <li className="muted">…and {issues.length - limit} more</li>}
          </ul>
          {techLinks.length > 0 && (
            <div className="row tiny" style={{ gap: 8, marginTop: 8 }}>
              <span className="muted">Also trains it:</span>
              {techLinks.map((t) => (
                <Link key={t.kind} to={`/exercise/${t.id}`} className="btn small">
                  {t.name}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
      {(onRetry || onNext || onReplay) && (
        <div className="row feedback-actions">
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
