import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/AppContext';
import { decodeBlob } from '../lib/audio/decode';
import { analyzeInBrowser } from '../lib/analysis/fallback';
import { alignLyrics, parseLyrics } from '../lib/analysis/lyrics';
import { identify, jobAnalysis, jobStatus, searchLyrics, startAnalysis } from '../lib/api';
import { saveAsset, saveSong } from '../lib/store/db';
import type { Lyrics, SongAnalysis, SongRecord } from '../lib/types';
import { uid, fmtTime } from '../lib/music/notes';
import { recommendSemitones } from '../lib/songs';

type Stage = 'pick' | 'details' | 'analysing' | 'error';

function guessFromFilename(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
  const m = /^(.+?)\s[-–]\s(.+)$/.exec(base);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: base, artist: '' };
}

export default function ImportSong() {
  const nav = useNavigate();
  const { profile, server, serverChecked, recheckServer } = useApp();
  const [stage, setStage] = useState<Stage>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [link, setLink] = useState('');
  const [lyricsText, setLyricsText] = useState('');
  const [lyricsSource, setLyricsSource] = useState<Lyrics['source']>('none');
  const [lyricsMsg, setLyricsMsg] = useState('');
  const [useServer, setUseServer] = useState(true);
  const [progress, setProgress] = useState(0);
  const [msg, setMsg] = useState('');
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUseServer(!!server?.ok);
  }, [server]);

  async function pick(f: File) {
    setErr('');
    setFile(f);
    const g = guessFromFilename(f.name);
    setTitle(g.title);
    setArtist(g.artist);
    try {
      const b = await decodeBlob(f);
      setBuffer(b);
      setStage('details');
    } catch {
      setErr('That file could not be decoded as audio. Try an MP3, M4A, WAV or OGG.');
    }
  }

  async function onIdentify() {
    if (!link.trim()) return;
    setLyricsMsg('Looking up the link…');
    try {
      const r = await identify(link.trim());
      if (r.title) setTitle(r.title);
      if (r.artist) setArtist(r.artist);
      setLyricsMsg(r.title ? `Found: ${r.artist ? r.artist + ' – ' : ''}${r.title}. Now fetch the lyrics.` : 'Could not read a title from that link.');
    } catch (e) {
      setLyricsMsg((e as Error).message);
    }
  }

  async function onFetchLyrics() {
    if (!title.trim()) {
      setLyricsMsg('Enter the title first.');
      return;
    }
    setLyricsMsg('Searching lyrics…');
    try {
      const r = await searchLyrics(title.trim(), artist.trim(), buffer?.duration);
      if (r.found && (r.synced || r.plain)) {
        setLyricsText(r.synced || r.plain || '');
        setLyricsSource('lrclib');
        setLyricsMsg(r.synced ? 'Synced lyrics found (timestamps included).' : 'Lyrics found, but not time-synced: they will be spread across the phrases.');
      } else setLyricsMsg('No lyrics found. You can paste them below.');
    } catch (e) {
      setLyricsMsg(`Lyrics lookup failed: ${(e as Error).message}`);
    }
  }

  async function analyse() {
    if (!file || !buffer || !profile) return;
    setStage('analysing');
    setProgress(0);
    const songId = uid();
    const lyrics = lyricsText.trim() ? parseLyrics(lyricsText, lyricsSource === 'lrclib' ? 'lrclib' : 'manual') : { source: 'none' as const, synced: false, lines: [] };
    let analysis: SongAnalysis | null = null;
    let jobId: string | null = null;
    let metaTitle = title.trim();
    let metaArtist = artist.trim();
    if (useServer && server?.ok) {
      try {
        setMsg('Uploading to the analysis server…');
        jobId = await startAnalysis(file, file.name, server.separation === 'demucs');
        // wait for the quick (mix-based) analysis
        for (;;) {
          const st = await jobStatus(jobId);
          setMsg(st.message || st.status);
          setProgress(Math.min(0.9, st.progress));
          if (st.meta) {
            if (!metaTitle && st.meta.title) metaTitle = st.meta.title;
            if (!metaArtist && st.meta.artist) metaArtist = st.meta.artist;
          }
          if (st.quickReady) {
            analysis = await jobAnalysis(jobId, 'quick');
            // If separation is still running, Practice keeps polling the job and upgrades the song
            // when the isolated vocal is ready. If the job already finished with a final result the
            // first poll picks it up; if it finished without one there is nothing more to wait for.
            if (st.status === 'done' && !st.finalReady) jobId = null;
            break;
          }
          if (st.status === 'failed') throw new Error(st.error || 'Server analysis failed');
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (e) {
        setMsg(`Server analysis unavailable (${(e as Error).message}). Analysing in the browser instead…`);
        analysis = null;
        jobId = null;
      }
    }
    if (!analysis) {
      try {
        setMsg('Extracting the melody in your browser (fallback mode)…');
        analysis = await analyzeInBrowser(buffer, (p) => setProgress(p));
      } catch (e) {
        setErr(`Analysis failed: ${(e as Error).message}`);
        setStage('error');
        return;
      }
    }
    alignLyrics(analysis, lyrics);
    const rec = recommendSemitones(analysis, profile);
    const song: SongRecord = {
      id: songId,
      createdAt: Date.now(),
      title: metaTitle || file.name,
      artist: metaArtist,
      duration: buffer.duration,
      analysis,
      lyrics,
      mode: analysis.mode,
      hasStems: false,
      preferredSemitones: 0,
      recommendedSemitones: rec.semitones,
      jobId,
    };
    setMsg('Saving…');
    await saveAsset({ id: `${songId}:original`, songId, kind: 'original', blob: file, mime: file.type || 'audio/mpeg' });
    await saveSong(song);
    nav(`/practice/${songId}`);
  }

  if (!profile) return null;

  return (
    <div style={{ maxWidth: 900 }} className="col">
      <h1>Add a song</h1>
      {stage === 'pick' && (
        <>
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) pick(f);
            }}
          >
            <h2>Drop an MP3 here</h2>
            <p className="muted">or click to choose a file. MP3, M4A, WAV and OGG work. The file never leaves your computer unless you run the analysis server.</p>
            <input ref={inputRef} type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          </div>
          {err && <div className="banner bad">{err}</div>}
          <div className="card flat small muted">
            <b>What happens next:</b> we separate the singer from the band, extract the vocal melody note by note (pitch, timing, slides, vibrato, dynamics,
            breath points) and sync the lyrics. Then you learn it phrase by phrase.
            <div style={{ marginTop: 6 }}>
              Analysis server: {serverChecked ? (server?.ok ? `connected (${server.separation === 'demucs' ? 'vocal separation available' : 'melody only, no separation'})` : 'not running — the browser fallback will be used') : 'checking…'}{' '}
              <a onClick={recheckServer} style={{ cursor: 'pointer' }}>
                recheck
              </a>
            </div>
          </div>
        </>
      )}
      {stage === 'details' && file && buffer && (
        <div className="col" style={{ gap: 16 }}>
          <div className="card col">
            <div className="row between">
              <div>
                <b>{file.name}</b> <span className="muted small">· {fmtTime(buffer.duration)} · {(file.size / 1e6).toFixed(1)} MB</span>
              </div>
              <button className="ghost small" onClick={() => setStage('pick')}>
                Choose another file
              </button>
            </div>
            <div className="grid cols-2">
              <label className="field">
                Title
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field">
                Artist
                <input type="text" value={artist} onChange={(e) => setArtist(e.target.value)} />
              </label>
            </div>
            <label className="field">
              Optional: YouTube or Spotify link, only to identify the song and fetch lyrics (the audio comes from your file)
              <div className="row">
                <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" style={{ flex: 1 }} disabled={!server?.ok} />
                <button onClick={onIdentify} disabled={!server?.ok || !link.trim()}>
                  Identify
                </button>
              </div>
            </label>
            <div className="row">
              <button onClick={onFetchLyrics} disabled={!server?.ok}>
                Fetch lyrics
              </button>
              <span className="small muted">{server?.ok ? lyricsMsg : 'Lyrics lookup needs the analysis server. You can paste lyrics instead.'}</span>
            </div>
            <label className="field">
              Lyrics (plain text, or LRC with [mm:ss.xx] timestamps for exact sync)
              <textarea
                value={lyricsText}
                onChange={(e) => {
                  setLyricsText(e.target.value);
                  setLyricsSource('manual');
                }}
                placeholder="Paste the lyrics here, one line per phrase…"
              />
            </label>
          </div>
          <div className="card col">
            <h3>Analysis</h3>
            {server?.ok ? (
              <label className="toggle">
                <input type="checkbox" checked={useServer} onChange={(e) => setUseServer(e.target.checked)} />
                Use the analysis server {server.separation === 'demucs' ? '(isolates the vocal with Demucs; a 4-minute song takes a few minutes on CPU, you can start practising meanwhile)' : '(melody only; separation is not installed on the server)'}
              </label>
            ) : (
              <div className="banner warn small">
                The analysis server is not running, so the song will be analysed in your browser from the full mix (fallback mode): synced lyrics, the
                extracted melody line and a guide tone over the original track. Start the server (see README) for the isolated vocal.
              </div>
            )}
            <div>
              <button className="primary big" onClick={analyse}>
                Analyse and start learning
              </button>
            </div>
          </div>
        </div>
      )}
      {stage === 'analysing' && (
        <div className="card col">
          <h2>Building the reference performance…</h2>
          <p className="muted">{msg}</p>
          <div className="bar">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="small muted">Pitch and key, melody line, note timing and length, slides and runs, vibrato, dynamics, breath points.</p>
        </div>
      )}
      {stage === 'error' && (
        <div className="card col">
          <div className="banner bad">{err}</div>
          <button onClick={() => setStage('details')}>Back</button>
        </div>
      )}
    </div>
  );
}
