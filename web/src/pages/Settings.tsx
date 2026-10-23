import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { getServerUrl, setServerUrl } from '../lib/api';
import RangeTestWizard from '../components/RangeTestWizard';
import { wipeAll } from '../lib/store/db';
import type { Level } from '../lib/types';
import { midiToName } from '../lib/music/notes';

export default function Settings() {
  const { profile, updateProfile, server, recheckServer, serverChecked } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [url, setUrl] = useState(getServerUrl());
  const [rangeOpen, setRangeOpen] = useState(loc.hash === '#range');
  useEffect(() => setRangeOpen(loc.hash === '#range'), [loc.hash]);
  if (!profile) return null;
  return (
    <div className="col" style={{ gap: 18, maxWidth: 900 }}>
      <h1>Settings</h1>
      <div className="card col" id="range">
        <div className="row between">
          <div>
            <h3>Vocal range</h3>
            <div className="muted small">
              {profile.rangeTests.length
                ? `${midiToName(profile.rangeTests.at(-1)!.lowMidi)} – ${midiToName(profile.rangeTests.at(-1)!.highMidi)} (${profile.rangeTests.at(-1)!.voiceType}), ${profile.rangeTests.length} test${profile.rangeTests.length === 1 ? '' : 's'}`
                : 'Not measured yet'}
            </div>
          </div>
          <button className="primary" onClick={() => setRangeOpen((v) => !v)}>
            {rangeOpen ? 'Close' : 'Re-test range'}
          </button>
        </div>
        {rangeOpen && (
          <RangeTestWizard
            onDone={async (r) => {
              await updateProfile((p) => ({ ...p, rangeTests: [...p.rangeTests, r] }));
              setRangeOpen(false);
            }}
          />
        )}
      </div>
      <div className="card col">
        <h3>Microphone</h3>
        <div className="muted small">
          {profile.calibration
            ? `${profile.calibration.deviceLabel ?? 'Default mic'} · noise ${profile.calibration.noiseFloorDb} dB · your level ${profile.calibration.singingLevelDb} dB · latency ${profile.calibration.latencyMs} ms · ${profile.calibration.leakDetected ? 'leak detected' : 'no leak'}`
            : 'Not calibrated'}
        </div>
        <div>
          <button onClick={() => nav('/calibration')}>Run the microphone check</button>
        </div>
      </div>
      <div className="card col">
        <h3>You</h3>
        <div className="grid cols-2">
          <label className="field">
            Name
            <input type="text" value={profile.name} onChange={(e) => updateProfile({ name: e.target.value })} />
          </label>
          <label className="field">
            Level (sets how strict the scoring is)
            <select value={profile.level} onChange={(e) => updateProfile({ level: e.target.value as Level })}>
              <option value="beginner">Beginner (±50 cents counts as on pitch)</option>
              <option value="intermediate">Intermediate (±35 cents)</option>
              <option value="advanced">Advanced (±20 cents)</option>
            </select>
          </label>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={profile.allowOctave} onChange={(e) => updateProfile({ allowOctave: e.target.checked })} />
          Accept singing an octave above or below the original (useful when the singer's voice type differs from yours)
        </label>
      </div>
      <div className="card col">
        <h3>Analysis server</h3>
        <p className="small muted">
          Optional local service that isolates the vocal (Demucs) and extracts the reference performance. Without it, songs are analysed in the
          browser in fallback mode. See <code>server/README.md</code>.
        </p>
        <div className="row">
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} style={{ maxWidth: 360 }} />
          <button
            onClick={async () => {
              setServerUrl(url);
              await recheckServer();
            }}
          >
            Save & test
          </button>
          <span className={`pill ${server?.ok ? 'good' : 'bad'}`}>
            {!serverChecked ? 'checking…' : server?.ok ? `connected · separation ${server.separation} · ${server.device}` : 'not reachable'}
          </span>
        </div>
      </div>
      <div className="card col">
        <h3>Privacy</h3>
        <p className="small muted">
          Your profile, songs, scores and recordings are stored only in this browser (IndexedDB) and never uploaded. The analysis server, if you run
          it, receives the song file for processing and deletes it when done. Lyrics lookups send only the title and artist.
        </p>
        <div>
          <button
            className="danger"
            onClick={async () => {
              if (confirm('Delete everything stored by Voice Coach in this browser? This cannot be undone.')) {
                await wipeAll();
                location.href = '/';
              }
            }}
          >
            Delete all my data
          </button>
        </div>
      </div>
    </div>
  );
}
