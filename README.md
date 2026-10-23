# Voice Coach

A browser app for a laptop that teaches you to sing the songs you love. It listens to your voice in real time, compares it with how the original singer performs the song, and coaches you phrase by phrase on pitch, timing, note length, slides, vibrato, dynamics and breathing.

Everything you record stays in your browser. The optional Python service only processes the song file you upload and deletes it afterwards.

## What it does

**Onboarding.** A short first session: microphone check (room noise, a headphone-leak test, your singing level), a guided range test (tones step down then up a semitone at a time while you match them), your closest voice type, and five "match the note" trials that measure pitch accuracy. You pick your level and goals, and everything after that adapts. A range re-test is suggested every three weeks.

**Song learning.** Upload an MP3 (or M4A, WAV, OGG). Optionally paste a YouTube or Spotify link only to identify the song and fetch lyrics; the audio always comes from your file. The app then builds a reference performance of the original vocal, note by note: pitch and key, melody line, note start and end, length, slides and runs, vibrato, dynamics, breath points, and chest/head register where detectable.

- With the analysis service running, Demucs isolates the vocal from the band. You can start practising straight away in fallback mode while separation runs in the background; the song upgrades itself when the isolated vocal is ready.
- Without the service (or if separation fails), fallback mode analyses the full mix in your browser: synced lyrics, the extracted melody line and a guide tone over the original track.

The practice view is a scrolling piano roll: the original melody as bars (with slide tails, vibrato waves, dynamic marks and breath marks), lyrics underneath, and your live pitch drawn on top, coloured green / amber / red by accuracy. Songs are split into phrases. For each phrase you can **Listen** (guide tones play the target notes), **Sing** with the band, the vocal, the original or the guide alone, **loop** it, slow it to 85 / 70 / 50 % without changing pitch, and **transpose** the key. The original key is the default; a lower key is offered and marked as the easier option, with a recommendation based on your range.

After every take you get a score for pitch, timing, note length and expression, the exact words or notes that were sharp, flat, late, early, short, missed, wobbly, lacking a slide or vibrato, too loud or soft, or where a breath was missing, plus one concrete tip and the exercise that trains it. **Full run** scores the whole song phrase by phrase, and **Replay my take** plays your recording against the original.

**Technique coaching.** A daily warm-up and twelve exercises tailored to your level and range: low breathing, long hiss (breath support), match the note, five-note scales, sirens, lip trills, long tones, reach higher (range extension), chest to head (register transitions), on the beat (entries), vibrato waves, and soft-loud-soft (dynamics). Pitched exercises run in the same practice engine with the same real-time feedback. Hard phrases link to the exercise that trains them. The app warns when high notes sound pushed and suggests a break after 20 minutes of singing and a real rest after 40.

**Progress.** Session history, scores per song and per phrase, range over time, pitch-accuracy trend, a personalised "practise next" plan, and an end-of-session recap with what improved and the one thing to fix next time.

## Running it

Requirements: Node 18+, a Chromium-based browser or Firefox (Web Audio, AudioWorklet, MediaRecorder), headphones, a laptop or USB microphone.

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

The browser app works on its own (fallback mode for songs). For isolated vocals and lyrics lookups, also run the analysis service:

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# optional, for vocal separation (CPU is fine, a 4-minute song takes a few minutes):
.venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -r requirements-separation.txt
.venv/bin/uvicorn main:app --port 8765
```

The web app looks for the service at `http://localhost:8765` (change it under Settings). See `server/README.md` for the endpoints and `docs/ANALYSIS_SCHEMA.md` for the analysis contract shared by the service and the in-browser analyser.

## How it works

| Part | Where | Notes |
|---|---|---|
| Real-time pitch tracking | `web/public/pitch-worklet.js`, `web/src/lib/audio/MicAnalyzer.ts` | YIN with parabolic interpolation inside an AudioWorklet, 2048-sample window, ~10 ms hop, octave-jump guard and glitch rejection on the main thread. |
| Playback, looping, slow-down, transposition | `web/src/lib/audio/Player.ts`, `render.ts`, `stretch.worker.ts` | WSOLA time-stretch in a worker plus resampling; phrase loops use sample-accurate loop points; guide tones are scheduled per loop pass. |
| Reference performance (server) | `server/analysis/` | ffmpeg decode, Demucs `htdemucs` separation, librosa pYIN melody, note segmentation and per-note features, phrasing, Krumhansl key detection, tempo. |
| Reference performance (browser fallback) | `web/src/lib/analysis/melodyExtract.ts`, `segment.ts` | YIN candidates re-ranked by harmonic salience (so chord tones and bass lose to the voice), parity-based octave correction, the same segmentation rules as the server. |
| Lyrics | `web/src/lib/analysis/lyrics.ts`, `server/analysis/lyrics.py` | LRC timestamps are matched to notes by time; plain lyrics are spread across phrases. Lookup via lrclib.net; link identification via public oEmbed only. |
| Scoring and feedback | `web/src/lib/scoring/score.ts` | Per-note pitch (cents, octave-tolerant), onset timing, held length, slides, vibrato, dynamics contour, breath points, broken lines; tolerance by level; one tip mapped to an exercise. |
| Exercises and plan | `web/src/lib/exercises/library.ts`, `web/src/lib/plan.ts` | Exercises are generated as synthetic reference "songs" from your measured range. |
| Storage | `web/src/lib/store/db.ts` | IndexedDB: profile, songs and stems, recordings, attempts, sessions, exercise results. Nothing leaves the browser. |

## Tests

```bash
cd web
npx tsx scripts/selftest.ts            # segmentation + scoring against synthesized singers
npm run build && npx vite preview      # then, in another shell:
python3 -I scripts/make_test_audio.py /tmp/testaudio
CHROMIUM_PATH=/path/to/chromium node scripts/e2e.mjs /tmp/testaudio http://localhost:4173
#   add E2E_SERVER=1 with the analysis service running to exercise the server path
cd ../server && .venv/bin/python tests/test_pipeline.py   # analysis pipeline + HTTP smoke test
```

## Known limits of this first version

- Chest/head register is a heuristic from harmonic energy and is only estimated on the isolated vocal.
- Fallback (full-mix) melody extraction is deliberately conservative and will miss notes that are quieter than the accompaniment.
- Time-stretch quality below 70 % is audibly phasey; it is meant for learning, not listening.
- Lip trills cannot be verified acoustically; the exercise checks pitch continuity only.
