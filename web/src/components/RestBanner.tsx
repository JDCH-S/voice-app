import { useApp } from '../lib/AppContext';

export default function RestBanner() {
  const { restBanner, dismissRest, session } = useApp();
  if (restBanner === 'none') return null;
  const mins = Math.round(session.activeSeconds / 60);
  return (
    <div className={`banner ${restBanner === 'strong' ? 'bad' : 'warn'}`} style={{ marginBottom: 16 }}>
      <div className="grow">
        {restBanner === 'strong'
          ? `You have been singing for about ${mins} minutes. Your voice needs a real break now: stop for at least 15 minutes, drink water, and avoid whispering.`
          : `About ${mins} minutes of singing so far. Take a 5-minute break: sip water, breathe low, and do not push the high notes when you come back.`}
      </div>
      <button onClick={dismissRest}>Got it</button>
    </div>
  );
}
