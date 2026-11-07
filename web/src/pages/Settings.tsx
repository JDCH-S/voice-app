import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { coachStatus, getServerUrl, setServerUrl, type CoachStatus } from '../lib/api';
import RangeTestWizard from '../components/RangeTestWizard';
import { wipeAll } from '../lib/store/db';
import type { Level } from '../lib/types';
import { midiToName } from '../lib/music/notes';
import { dailyGoalMinutes, parseReminderTime } from '../lib/habits';
import { notificationSupport, reminderStatusText, requestNotificationPermission, showReminder, type ReminderSupport } from '../lib/notifications';
import { describeSummary, downloadBlob, exportAll, importAll, readExportFile, summarize, type ExportFile, type ImportSummary } from '../lib/store/export';

export default function Settings() {
  const { profile, updateProfile, server, recheckServer, serverChecked } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [url, setUrl] = useState(getServerUrl());
  const [rangeOpen, setRangeOpen] = useState(loc.hash === '#range');
  const [support, setSupport] = useState<ReminderSupport>(notificationSupport());
  const [goalText, setGoalText] = useState<string>(String(dailyGoalMinutes(profile)));
  const [includeAudio, setIncludeAudio] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ file: ExportFile; summary: ImportSummary } | null>(null);
  const [importMsg, setImportMsg] = useState<{ kind: 'good' | 'bad'; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [coach, setCoach] = useState<CoachStatus | null | 'checking'>('checking');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setRangeOpen(loc.hash === '#range'), [loc.hash]);
  useEffect(() => {
    if (loc.hash) {
      const el = document.getElementById(loc.hash.slice(1));
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }, [loc.hash]);
  useEffect(() => {
    if (profile) setGoalText(String(dailyGoalMinutes(profile)));
  }, [profile?.dailyGoalMinutes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    coachStatus().then((s) => alive && setCoach(s));
    return () => {
      alive = false;
    };
  }, [server]);

  if (!profile) return null;

  async function setReminder(value: string) {
    const t = value ? parseReminderTime(value) : null;
    const reminderTime = t ? `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` : null;
    await updateProfile({ reminderTime });
    if (reminderTime) setSupport(await requestNotificationPermission());
  }

  async function doExport() {
    setExporting(true);
    setExportMsg(null);
    try {
      const { blob, filename, summary } = await exportAll({ includeAudio });
      downloadBlob(blob, filename);
      setExportMsg(`Saved ${filename} (${(blob.size / 1e6).toFixed(1)} MB): ${describeSummary(summary)}`);
    } catch (e) {
      setExportMsg(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  async function pickImport(f: File) {
    setImportMsg(null);
    setPendingImport(null);
    try {
      const file = await readExportFile(f);
      setPendingImport({ file, summary: summarize(file) });
    } catch (e) {
      setImportMsg({ kind: 'bad', text: (e as Error).message });
    }
  }

  async function confirmImport() {
    if (!pendingImport) return;
    setImporting(true);
    try {
      const s = await importAll(pendingImport.file);
      setPendingImport(null);
      setImportMsg({ kind: 'good', text: `Imported ${describeSummary(s)} Reloading…` });
      setTimeout(() => {
        location.href = '/';
      }, 1200);
    } catch (e) {
      setImportMsg({ kind: 'bad', text: `Import failed: ${(e as Error).message}` });
    } finally {
      setImporting(false);
    }
  }

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
        <label className="toggle">
          <input type="checkbox" checked={profile.adaptiveDifficulty ?? true} onChange={(e) => updateProfile({ adaptiveDifficulty: e.target.checked })} />
          Auto-adjust difficulty while practising (slows down and turns the guide on after two low scores, speeds up after two high ones)
        </label>
      </div>
      <div className="card col" id="habits">
        <h3>Daily habit</h3>
        <div className="grid cols-2">
          <label className="field">
            Daily goal (minutes of singing)
            <input
              type="number"
              min={1}
              max={180}
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              onBlur={() => {
                const v = Math.round(parseFloat(goalText));
                const mins = isFinite(v) && v > 0 ? Math.min(180, v) : dailyGoalMinutes(null);
                setGoalText(String(mins));
                updateProfile({ dailyGoalMinutes: mins });
              }}
            />
            <span className="tiny muted" style={{ fontWeight: 400 }}>
              Ten minutes a day beats an hour on Sunday. Days with at least a minute of singing keep your streak.
            </span>
          </label>
          <label className="field">
            Reminder time
            <div className="row">
              <input type="time" value={profile.reminderTime ?? ''} onChange={(e) => setReminder(e.target.value)} style={{ maxWidth: 160 }} />
              {profile.reminderTime && (
                <button className="ghost small" onClick={() => setReminder('')}>
                  Turn off
                </button>
              )}
              {profile.reminderTime && support === 'granted' && (
                <button className="ghost small" onClick={() => showReminder('Time to sing', 'This is what the reminder looks like.')}>
                  Test
                </button>
              )}
            </div>
            <span className="tiny muted" style={{ fontWeight: 400 }}>
              {reminderStatusText(profile, support)}
            </span>
          </label>
        </div>
      </div>
      <div className="card col">
        <h3>Analysis server</h3>
        <p className="small muted">
          The part of Voice Coach that isolates the singer's voice and reads the notes. When you start Voice Coach with the start file it runs
          automatically at this same address. Without it, songs are analysed in the browser in fallback mode.
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
            {!serverChecked
              ? 'checking…'
              : server?.ok
                ? `connected · separation ${server.separation} · ${server.device}${server.whisper !== undefined ? ` · speech recognition ${server.whisper ? 'ready' : 'not installed'}` : ''}`
                : 'not reachable'}
          </span>
        </div>
        <div className="row small">
          <b>AI coach:</b>
          <span className={`pill ${coach === 'checking' ? '' : coach?.available ? 'good' : 'near'}`}>
            {coach === 'checking' ? 'checking…' : !coach ? 'not available (needs the analysis server)' : coach.available ? `ready · ${coach.model}` : 'needs a key'}
          </span>
          <Link to="/coach">Open the coach</Link>
        </div>
      </div>
      <div className="card col" id="data">
        <h3>Your data: export and import</h3>
        <p className="small muted">
          Save everything (profile, songs with their analysis, takes, sessions, reviews, game results, coach chats) to one file you can keep or move to
          another computer. Tick the box to include your recordings and the song audio: the file gets much bigger, but the songs play without re-importing
          the MP3s.
        </p>
        <div className="row">
          <label className="toggle small">
            <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} />
            Include recordings and audio
          </label>
          <button className="primary" onClick={doExport} disabled={exporting} data-testid="export-btn">
            {exporting ? 'Preparing…' : 'Export my data'}
          </button>
          <label className="btn file-btn">
            Import a file…
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickImport(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        {exportMsg && <div className="banner info small">{exportMsg}</div>}
        {pendingImport && (
          <div className="banner warn small col" style={{ alignItems: 'stretch' }}>
            <div>
              <b>Import this file?</b> It contains {describeSummary(pendingImport.summary)} Records with the same id replace yours; everything else is
              kept.
            </div>
            <div className="row">
              <button className="primary" onClick={confirmImport} disabled={importing}>
                {importing ? 'Importing…' : 'Yes, import and merge'}
              </button>
              <button onClick={() => setPendingImport(null)} disabled={importing}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {importMsg && <div className={`banner ${importMsg.kind} small`}>{importMsg.text}</div>}
      </div>
      <div className="card col">
        <h3>Privacy</h3>
        <p className="small muted">
          Your profile, songs, scores and recordings are stored only in this browser (IndexedDB) and never uploaded. The analysis server, if you run
          it, receives the song file for processing and deletes it when done. Lyrics lookups send only the title and artist. The coach, if you set it up,
          receives your scores and range as numbers, never audio.
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
