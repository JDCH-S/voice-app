import { useEffect, useState } from 'react';
import type { GameResult } from '../../lib/types';
import type { KaraokeState, GameOutcome } from '../../lib/game';

export function Stars({ n, size = 1, max = 5 }: { n: number; size?: number; max?: number }) {
  return (
    <span className="stars" style={{ fontSize: `${size}em` }} aria-label={`${n} of ${max} stars`}>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} className={i < n ? 'on' : ''}>
          ★
        </i>
      ))}
    </span>
  );
}

/** Points, combo and multiplier, polled from the scorer at animation rate (no React state per frame). */
export default function GameHud({ read, phraseCount }: { read: () => KaraokeState | null; phraseCount: number }) {
  const [s, setS] = useState<KaraokeState | null>(null);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    let raf = 0;
    let lastPoints = -1;
    let lastMult = 1;
    const loop = () => {
      const st = read();
      if (st) {
        if (st.points !== lastPoints || st.multiplier !== lastMult) {
          if (st.multiplier > lastMult) setPulse((p) => p + 1);
          lastPoints = st.points;
          lastMult = st.multiplier;
          setS({ ...st });
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [read]);
  const points = s?.points ?? 0;
  const combo = s?.combo ?? 0;
  const mult = s?.multiplier ?? 1;
  const starsSoFar = (s?.phrasesDone ?? []).reduce((a, p) => a + p.stars, 0);
  return (
    <div className="game-hud" aria-live="off">
      <div className="game-points">
        <span className="game-points-val">{points.toLocaleString()}</span>
        <span className="game-points-label">points</span>
      </div>
      <div className={`game-combo ${combo >= 5 ? 'hot' : ''}`} key={pulse}>
        <span className="game-mult">×{mult}</span>
        <span className="game-combo-n">{combo > 0 ? `${combo} in a row` : 'combo'}</span>
      </div>
      <div className="game-stars-sofar">
        <span className="star-glyph">★</span> {starsSoFar}
        <span className="tiny muted"> / {phraseCount * 5}</span>
      </div>
    </div>
  );
}

/** The screen at the end of a game: stars, points, best-ever, per-phrase stars. Playful on purpose. */
export function GameEndScreen({
  outcome,
  best,
  isNewBest,
  phraseTexts,
  onAgain,
  onPractise,
}: {
  outcome: GameOutcome;
  best: GameResult | null;
  isNewBest: boolean;
  phraseTexts: string[];
  onAgain: () => void;
  onPractise: (phraseIndex: number) => void;
}) {
  const worst = [...outcome.perPhrase].sort((a, b) => a.score - b.score)[0];
  const headline =
    outcome.stars >= 5 ? 'Flawless!' : outcome.stars >= 4 ? 'Superb!' : outcome.stars >= 3 ? 'Nice one!' : outcome.stars >= 2 ? 'Getting there!' : outcome.stars >= 1 ? 'Warmed up!' : 'Brave start!';
  return (
    <div className="card game-end fade-in">
      <div className="game-end-top">
        <div className="game-end-stars">
          <Stars n={outcome.stars} size={2.4} />
          <div className="game-end-headline">{headline}</div>
        </div>
        <div className="game-end-numbers">
          <div>
            <b className="game-end-points">{outcome.points.toLocaleString()}</b>
            <span className="tiny muted">points</span>
          </div>
          <div>
            <b>{outcome.maxCombo}</b>
            <span className="tiny muted">best combo</span>
          </div>
          <div>
            <b>{outcome.score}%</b>
            <span className="tiny muted">on pitch</span>
          </div>
        </div>
      </div>
      <div className="game-best small">
        {isNewBest ? (
          <span className="pill good">New best ever{best ? ` (was ${best.points.toLocaleString()})` : ''}</span>
        ) : best ? (
          <span className="pill">
            Best ever: {best.points.toLocaleString()} points, {best.stars} ★ on {new Date(best.date).toLocaleDateString()}
          </span>
        ) : null}
      </div>
      <div className="game-phrases">
        {outcome.perPhrase.map((p) => (
          <button key={p.phraseIndex} className="game-phrase" onClick={() => onPractise(p.phraseIndex)} title="Practise this phrase">
            <span className="tiny muted">
              {p.phraseIndex + 1}. {phraseTexts[p.phraseIndex]?.slice(0, 22) || 'phrase'}
            </span>
            <Stars n={p.stars} size={0.9} />
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="primary" onClick={onAgain}>
          Play again
        </button>
        {worst && <button onClick={() => onPractise(worst.phraseIndex)}>Practise phrase {worst.phraseIndex + 1}</button>}
      </div>
      <div className="tiny muted" style={{ marginTop: 6 }}>
        Game points are for fun. Your honest scores and coaching tips live in "Learn phrase by phrase" and "Sing along".
      </div>
    </div>
  );
}
