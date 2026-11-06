import { useEffect, useRef, useState } from 'react';
import { estimatedLatencyMs, measureLatency, mic, type LatencyResult, type RawPitch } from '../lib/audio/MicAnalyzer';
import { player } from '../lib/audio/Player';
import { useMicPitch } from '../lib/useMic';
import PitchMeter from './PitchMeter';
import type { MicCalibration } from '../lib/types';
import { mean } from '../lib/music/notes';

/**
 * Silence gate for the pitch tracker. It sits a little above the room noise but always well below
 * the singing level, and never higher than -48 dBFS: the tracker's own clarity check rejects noise,
 * so a gate that is too low costs little while one that is too high silences the singer.
 */
export function gateFor(noiseDb: number, singDb: number | null): number {
  let g = noiseDb + 6;
  if (singDb !== null) g = Math.min(g, singDb - 15);
  return Math.max(-65, Math.min(-48, g));
}

type Step = 'intro' | 'silence' | 'leak' | 'sing' | 'delay' | 'done';

export default function CalibrationWizard({ onDone, compact }: { onDone: (c: MicCalibration) => void; compact?: boolean }) {
  const [step, setStep] = useState<Step>('intro');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const { frame, error, ready } = useMicPitch(step !== 'intro');
  const [progress, setProgress] = useState(0);
  const [noise, setNoise] = useState<number | null>(null);
  const [leak, setLeak] = useState<boolean | null>(null);
  const [singLevel, setSingLevel] = useState<number | null>(null);
  const [clipped, setClipped] = useState(false);
  const [latency, setLatency] = useState<LatencyResult | null>(null);
  const [clickNo, setClickNo] = useState(0);
  const [measuring, setMeasuring] = useState(false);
  const buf = useRef<RawPitch[]>([]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.().then((ds) => setDevices(ds.filter((d) => d.kind === 'audioinput')));
  }, [ready]);

  useEffect(() => {
    if (step === 'intro' || step === 'delay' || step === 'done') return;
    const unsub = mic.subscribe((f) => buf.current.push(f));
    return unsub;
  }, [step]);

  async function changeDevice(id: string) {
    setDeviceId(id);
    mic.stop();
    await mic.start(id || undefined);
  }

  function collect(seconds: number, onTick?: (p: number) => void): Promise<RawPitch[]> {
    buf.current = [];
    return new Promise((resolve) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        const p = (performance.now() - t0) / (seconds * 1000);
        onTick?.(Math.min(1, p));
        if (p >= 1) {
          clearInterval(iv);
          resolve(buf.current.slice());
        }
      }, 50);
    });
  }

  async function runSilence() {
    setStep('silence');
    const fs = await collect(2.5, setProgress);
    const dbs = fs.map((f) => f.db).filter((d) => d > -100);
    const n = dbs.length ? mean(dbs) : -70;
    setNoise(n);
    await runLeak(n);
  }

  async function runLeak(noiseDb: number) {
    setStep('leak');
    setProgress(0);
    // play a tone through the speakers while the user stays silent
    const tonePromise = player.tone(69, 2.2, 0.5);
    const fs = await collect(2.2, setProgress);
    await tonePromise;
    const pitched = fs.filter((f) => f.hz > 0 && f.clarity > 0.8 && Math.abs(1200 * Math.log2(f.hz / 440)) < 60);
    const loud = fs.filter((f) => f.db > noiseDb + 8);
    const leaked = pitched.length > fs.length * 0.25 || loud.length > fs.length * 0.5;
    setLeak(leaked);
  }

  async function runSing() {
    setStep('sing');
    setProgress(0);
    const fs = await collect(3, setProgress);
    const voiced = fs.filter((f) => f.hz > 0);
    const dbs = (voiced.length ? voiced : fs).map((f) => f.db).filter((d) => d > -100);
    const lvl = dbs.length ? mean(dbs) : -40;
    setSingLevel(lvl);
    setClipped(fs.some((f) => f.peak > 0.97));
    setStep('delay');
  }

  async function runDelay() {
    setMeasuring(true);
    setClickNo(0);
    try {
      const r = await measureLatency({ clicks: 4, onClick: (k) => setClickNo(k + 1) });
      setLatency(r);
    } catch {
      const est = estimatedLatencyMs();
      setLatency({ latencyMs: est, measured: false, detected: 0, clicks: 4, offsetsMs: [], message: `The clicks could not be played. Using the estimate of ${est} ms.` });
    } finally {
      setMeasuring(false);
    }
    setStep('done');
  }

  function skipDelay() {
    const est = estimatedLatencyMs();
    setLatency({ latencyMs: est, measured: false, detected: 0, clicks: 0, offsetsMs: [], message: `Delay not measured. Using the estimate of ${est} ms.` });
    setStep('done');
  }

  function finish() {
    const noiseDb = noise ?? -70;
    const gateDb = gateFor(noiseDb, singLevel);
    const cal: MicCalibration = {
      date: Date.now(),
      noiseFloorDb: Math.round(noiseDb * 10) / 10,
      singingLevelDb: Math.round((singLevel ?? -30) * 10) / 10,
      gateDb: Math.round(gateDb * 10) / 10,
      latencyMs: latency?.latencyMs ?? estimatedLatencyMs(),
      leakDetected: !!leak,
      deviceLabel: mic.deviceLabel,
    };
    mic.setGate(Math.pow(10, gateDb / 20));
    mic.setReferenceLevel(singLevel);
    onDone(cal);
  }

  const tooQuiet = singLevel !== null && noise !== null && singLevel - noise < 12;

  return (
    <div className="col" style={{ gap: 16 }}>
      {!compact && <h2>Microphone check</h2>}
      {error && <div className="banner bad">Microphone error: {error}. Allow microphone access in the browser bar and reload.</div>}
      {step === 'intro' && (
        <>
          <p>
            Put your <b>headphones on</b> so the music does not reach the microphone. Then we measure the room noise, check for sound leaking from
            speakers, set your singing level and measure the sound delay. Takes about 30 seconds.
          </p>
          <button className="primary big" onClick={runSilence}>
            Start the check
          </button>
        </>
      )}
      {step !== 'intro' && (
        <div className="row between">
          <label className="field" style={{ minWidth: 300 }}>
            Microphone
            <select value={deviceId} onChange={(e) => changeDevice(e.target.value)}>
              <option value="">Default{mic.deviceLabel ? ` (${mic.deviceLabel})` : ''}</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {step === 'silence' && (
        <div className="card flat">
          <h3>1. Stay quiet</h3>
          <p className="muted">Measuring the noise in the room…</p>
          <div className="bar">
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
      {step === 'leak' && (
        <div className="card flat">
          <h3>2. Keep quiet, we play a tone</h3>
          <p className="muted">If your headphones are on, the microphone should hear nothing.</p>
          <div className="bar">
            <span style={{ width: `${progress * 100}%` }} />
          </div>
          {leak !== null && (
            <div style={{ marginTop: 12 }} className="col">
              {leak ? (
                <div className="banner warn">
                  The microphone heard the tone. Sound from your speakers is leaking in, which confuses the pitch tracking. Please use headphones,
                  then run the check again. You can continue, but scores will be less accurate.
                </div>
              ) : (
                <div className="banner good">No leak detected. Headphones look good.</div>
              )}
              <div className="row">
                <button className="primary" onClick={runSing}>
                  Next: sing a note
                </button>
                {leak && <button onClick={() => runLeak(noise ?? -70)}>Run the leak test again</button>}
              </div>
            </div>
          )}
        </div>
      )}
      {step === 'sing' && (
        <div className="card flat">
          <h3>3. Sing "ah" at a normal volume</h3>
          <p className="muted">Hold any comfortable note for three seconds.</p>
          <div className="bar">
            <span style={{ width: `${progress * 100}%` }} />
          </div>
          <div style={{ marginTop: 14 }}>
            <PitchMeter frame={frame} />
          </div>
        </div>
      )}
      {step === 'delay' && (
        <div className="card flat col">
          <h3>4. Measure the delay</h3>
          <p className="muted">
            Sound takes a moment to go from the app to your ears and from your voice back into the app. Knowing that delay keeps your timing scores
            honest. <b>Take your headphones off</b> (or hold one earcup against the microphone) for five seconds: we play four clicks and time how
            long they take to reach the microphone. Put the headphones back on afterwards.
          </p>
          {measuring ? (
            <>
              <div className="bar">
                <span style={{ width: `${(clickNo / 4) * 100}%` }} />
              </div>
              <p className="muted">{clickNo === 0 ? 'Listening to the room…' : `Click ${clickNo} of 4…`}</p>
            </>
          ) : (
            <div className="row">
              <button className="primary" onClick={runDelay}>
                Play the clicks
              </button>
              <button onClick={skipDelay}>Skip (use an estimate)</button>
            </div>
          )}
        </div>
      )}
      {step === 'done' && (
        <div className="card flat col">
          <h3>Microphone ready</h3>
          <div className="row" style={{ gap: 24 }}>
            <div>
              <div className="tiny muted">Room noise</div>
              <b>{noise?.toFixed(0)} dB</b>
            </div>
            <div>
              <div className="tiny muted">Your level</div>
              <b>{singLevel?.toFixed(0)} dB</b>
            </div>
            <div>
              <div className="tiny muted">Leak</div>
              <b>{leak ? 'detected' : 'none'}</b>
            </div>
            <div>
              <div className="tiny muted">Delay</div>
              <b className="latency-result">
                {latency?.latencyMs ?? estimatedLatencyMs()} ms {latency?.measured ? '(measured)' : '(estimated)'}
              </b>
            </div>
          </div>
          {latency && <div className={`banner ${latency.measured ? 'good' : 'warn'}`}>{latency.message}</div>}
          {clipped && <div className="banner warn">The signal clipped. Move a little further from the microphone or lower its input gain.</div>}
          {tooQuiet && <div className="banner warn">Your voice is barely louder than the room. Move closer to the microphone or raise its input gain.</div>}
          <div className="row">
            <button className="primary big" onClick={finish}>
              Save and continue
            </button>
            <button onClick={() => setStep('delay')}>Measure the delay again</button>
            <button onClick={runSilence}>Redo</button>
          </div>
        </div>
      )}
    </div>
  );
}
