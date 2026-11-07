# Voice coach analysis service

Local Python service that turns a song file into the `SongAnalysis` JSON the
web app practises against (reference melody, notes with slides / vibrato /
dynamics / breaths, phrases, key, tempo, range) and, optionally, splits the
song into a vocal and an instrumental stem with Demucs.

The JSON contract is `docs/ANALYSIS_SCHEMA.md` (TypeScript: `web/src/lib/types.ts`).

## Install

Requirements: Python 3.11+ (tested on 3.13) and `ffmpeg` on the PATH
(`/usr/bin/ffmpeg`; override with `FFMPEG_BIN`). mp3 stems need an ffmpeg with
`libmp3lame`; otherwise stems are served as 16-bit wav.

```bash
cd server
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt            # analysis only (fastapi, librosa, ...)
```

Optional vocal separation (CPU is fine, a GPU is faster):

```bash
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu   # CPU wheels, ~200 MB
pip install -r requirements-separation.txt                                     # demucs
```

If `download.pytorch.org` is not reachable, `pip install torch torchaudio` from
PyPI also works but pulls the CUDA libraries (several GB). Demucs downloads the
`htdemucs` weights (~80 MB) from `dl.fbaipublicfiles.com` on first use into the
torch hub cache; to run fully offline, put the model files in a folder and set
`DEMUCS_REPO=/path/to/folder`.

Optional word timing with speech recognition (faster-whisper, CPU int8):

```bash
pip install -r requirements-words.txt
```

The model (`VOICECOACH_WHISPER_MODEL`, default `small`, ~480 MB) is downloaded from
huggingface.co and its CDN on first use (plain HTTPS; the Xet transfer protocol is
disabled because its hosts are often blocked). If the download fails, `/jobs/{id}/words`
answers 503 with the reason and everything else keeps working.

Optional AI coach (Anthropic Messages API): the `anthropic` package is installed with
`requirements.txt`; a key is needed at run time (see `/coach/key` below).

## Single-program mode

If `web/dist` exists (run `npm run build` in `web/`), this service also serves the web app at `/`, with unknown paths falling back to `index.html`. The app then talks to the service at its own address, so Voice Coach runs as one program. The start scripts in the repository root (`Start Voice Coach.bat`, `start.sh`) do this on port 5173. `VOICECOACH_WEB_DIST` overrides the folder, and `VOICECOACH_OPEN_BROWSER=<url>` opens a browser tab once the server is up. ffmpeg comes from `imageio-ffmpeg` when it isn't on the PATH, so nothing else needs installing on Windows or Mac.

## Run

```bash
cd server
.venv/bin/uvicorn main:app --port 8765
```

`GET /health` tells you what is available:
`{"ok": true, "separation": "demucs" | "unavailable", "device": "cpu", "version": "0.2.0", "whisper": true|false, "whisperModel": "small"|null, "coach": true|false}`.

Environment variables: `VOICE_JOBS_DIR` (job scratch dir, default `server/.jobs`),
`VOICE_MAX_UPLOAD_MB` (default 200), `DEMUCS_MODEL` (default `htdemucs`),
`DEMUCS_THREADS` (default 4), `DEMUCS_REPO` (offline model folder), `FFMPEG_BIN`,
`VOICECOACH_ORIGINS` (comma-separated browser origins allowed by CORS, default `*`;
localhost is always allowed), `VOICECOACH_WHISPER_MODEL` (`tiny`/`base`/`small`/`medium`,
default `small`), `VOICECOACH_WHISPER_LANGUAGE` (ISO code; default auto-detect),
`VOICECOACH_WHISPER_THREADS` (default 4), `VOICECOACH_COACH_MODEL` (default
`claude-sonnet-5-5`), `ANTHROPIC_API_KEY`, `VOICECOACH_SECRETS_DIR` (where the key saved
from the app lives, default `server/.secrets`). Deployment with Docker: `docs/DEPLOY.md`.

## Endpoints

| method / path | what it does |
|---|---|
| `GET /health` | service status: whether Demucs (`separation`), faster-whisper (`whisper`) and the coach SDK (`coach`) are installed, device |
| `POST /analyze` | multipart form: `file` (any audio ffmpeg can read), `separate` = `"true"`/`"false"`, `words` = `"true"`(default)/`"false"` (word timing with speech recognition). Returns `{ jobId }` immediately. |
| `GET /jobs/{id}` | `{ status, progress, message, meta, quickReady, finalReady, wordsReady, wordsError, separationWeak, error }`. `status` goes `queued → decoding → quick → separating → finalizing → done` (or `failed`). `meta` = `{ title, artist, duration, tags }` from the file's tags (mutagen) or an `Artist - Title` filename. `wordsReady` becomes true together with `finalReady` (separation jobs) or `quickReady` (jobs without separation): a client that stops polling at that point loses nothing. `wordsError` says why words are missing (`"not requested"`, model not installed / download failed, ...). `separationWeak` is true when the isolated vocal was nearly silent or gave fewer than 40 % of the mix analysis' notes: the stems are kept but `/analysis/final` is then the full-mix analysis (`mode: "mix"`) with the warning "Vocal separation found very little voice in this file; using the full-mix melody". |
| `GET /jobs/{id}/analysis/quick` | `SongAnalysis` with `mode: "mix"` — computed from the full mix right after decoding, so practice can start while separation runs. 404 until `quickReady`. |
| `GET /jobs/{id}/analysis/final` | `SongAnalysis` with `mode: "separated"` — computed on the isolated vocal (adds `register`, cleaner melody). 404 unless `finalReady`. |
| `GET /jobs/{id}/stems/vocals`, `.../stems/instrumental` | mono stems, `audio/mpeg` (mp3, `-q:a 4`) or `audio/wav`. instrumental = mixture − vocals. |
| `GET /jobs/{id}/words` | `{ words: WordTiming[], language, languageProbability, model }` — the words recognised in the isolated vocal (or the mix) with `{ t0, t1, text, conf }` each, word starts snapped to the melody's note onsets. 404 until `wordsReady` (or when `words=false` was requested), 503 with a clear `detail` when faster-whisper is not installed or its model could not be loaded. |
| `POST /jobs/{id}/align` | JSON `{ lyrics }` (the user's own text; LRC timestamps and `[section]` tags are ignored) → `{ words: WordTiming[], matched, total }`: one entry per word of the user's text, in order and with the user's spelling. Words that match the recognition take its timing and confidence; misheard words paired one to one get the timing with a reduced `conf`; everything else is interpolated between its neighbours (`conf` 0). Same 404/503 rules as `/words`. |
| `DELETE /jobs/{id}` | removes the upload and every output. Jobs are purged automatically after 2 hours. |
| `POST /identify` | JSON `{ url }` → `{ title, artist, source: "youtube" \| "spotify" \| "unknown" }` from the public oEmbed endpoints only (no API keys, no audio download). 502 if the lookup fails. |
| `POST /lyrics/search` | JSON `{ title, artist, duration? }` → `{ found, synced (LRC), plain, title, artist, source: "lrclib" }` from lrclib.net. `found: false` when nothing matches, 502 if lrclib is unreachable. |
| `GET /coach/status` | `{ available, model, keySource: "env" \| "file" \| "none", message? }`. `available` is the result of a cheap live check (`GET /v1/models/{model}`, cached 10 min) with the key that would be used; `message` says what to do when it is false. |
| `POST /coach/key` | JSON `{ key }` → the new status. Stores the key in `<VOICECOACH_SECRETS_DIR>/anthropic_key` (mode 600, directory 700, git-ignored); an empty key removes it. 400 for something that is not shaped like a key. |
| `POST /coach` | JSON `{ messages: [{ role: "user" \| "assistant", content }], context }` → `{ reply }`. The last 30 turns are sent with a compact version of `context` (see below). 401 with `detail` "The coach needs an Anthropic API key: add your Anthropic API key in Settings …" when no working key exists, 429 when rate-limited, 422 when the model declines, 502/503/504 for upstream problems — `detail` is always a sentence the app can show. |
| `POST /coach/plan` | JSON `{ context }` → `WeeklyPlan` (`types.ts`): `{ weekStart, summary, days: 7 × { day, focus, items: [{ kind, title, exerciseId, songId, phraseIndex, minutes }] }, source: "coach" }`. The model answers through structured output (a JSON schema the API enforces); the server validates again, fills missing days with rest, nulls exercise/song ids that are not in the context and caps a day at 25 minutes. `weekStart` is taken from `context.weekStart` (epoch ms). |

**Coach context.** `context` is any JSON the app assembles; the server trims it before sending
(`attempts` cut to the last 30 and summarised to date/song/phrase/scores/issue counts, raw frame or
melody arrays dropped, the whole thing capped at ~14 kB). Useful keys: `profile` (level, goals,
dailyGoalMinutes), `range` (lowMidi, highMidi, voiceType), `attempts`, `songs` (`[{ id, title,
phrases }]` — `phrases` as a count or list), `exercises` (`[{ id, title }]` or ids; without it the
plan may only reference the app's built-in exercise ids), `reviews`, `weekStart`. Model:
`VOICECOACH_COACH_MODEL` (default `claude-sonnet-5-5`). Key resolution: `ANTHROPIC_API_KEY`, else
the saved file, else the call is attempted without a key (a development proxy may authenticate
it) and a 401 is turned into the "add your key in Settings" message. Message content is never
logged.

Quick analysis of a 4-minute song takes roughly 30–60 s on 4 CPU cores (pyin is
the expensive part). **Vocal separation on CPU takes a few minutes for a
4-minute song** (htdemucs, 4 threads); the quick analysis is served while it
runs. Separation jobs run one at a time so the CPU is not oversubscribed.

If separation is requested but fails (for example the model weights cannot be
downloaded), the job ends in `status: "failed"` with `error` set, but
`quickReady` stays true and `/analysis/quick` keeps working.

## Privacy

Uploaded audio and stems live in `server/.jobs/<job>/` only for the lifetime of
the job: they are removed by `DELETE /jobs/{id}` or by the 2-hour purge, and
file contents are never logged. Speech recognition runs locally. Nothing leaves
the machine except the optional metadata lookups (`/identify` → YouTube / Spotify
oEmbed, `/lyrics/search` → lrclib.net), which send only a URL or a
title/artist/duration, and the AI coach (`/coach`, `/coach/plan`), which sends the
conversation and the compact practice summary to api.anthropic.com only when the
user asks the coach. Coach messages are not logged; the saved key is readable by
the service user only.

## Word timing quality

faster-whisper was built for speech, and singing stretches vowels over held notes, so its raw
word stamps are rough. Measured on a real a cappella English clip (64 s, phone-level manual
alignment; model `small`, int8, 4 threads, 5 s of recognition):

* speech VAD **off** (the default here): the whole lyric is recognised (42 words); with VAD on, half
  the words were dropped and onsets were > 1 s off, so VAD is disabled for singing;
* raw whisper word starts vs the true phrase onsets (first phone after a silence): median error
  310 ms, 42 % within 200 ms, 83 % within 500 ms;
* after snapping each word start to the nearest melody note onset within 0.6 s
  (`words.snap_to_notes`, done in the job): median 43 ms, 67 % within 100 ms, 75 % within 200 ms;
  word starts vs the nearest vowel onset anywhere in the clip: median 112 ms, 79 % within 200 ms.

The frontend then matches words to notes by time, so what matters is which note a word starts
on, and that is right for roughly three words in four on that clip. Expect worse on a separated
vocal with bleed and on dense fast lyrics; `conf` carries whisper's word probability.

## How the analysis works

* **Decoding** – ffmpeg → mono float32 22 050 Hz (analysis) and 44.1 kHz stereo wav (Demucs input).
* **Melody** (`analysis/melody.py`) – `librosa.pyin` (fmin 65 Hz / C2, fmax 1100 Hz, frame 2048, hop 256 ≈ 11.6 ms).
  In `mix` mode the mix is first HPSS-filtered, high-passed at 150 Hz and tracked with a
  more permissive YIN threshold prior; frames count as voiced when `voiced_prob > 0.5`
  and the frame RMS is above the median − 10 dB; sub-octave errors (pyin locking onto a
  bass note under the voice) are corrected by comparing even vs odd harmonic energy.
  In `separated` mode the thresholds are `voiced_prob > 0.35` and RMS > −45 dBFS.
  Then: 5-frame median filter, voiced islands < 4 frames dropped, short octave
  glitches (< 150 ms, an octave off both neighbours) folded back.
* **Notes** (`analysis/notes.py`) – each voiced run is cut where the smoothed pitch leaves
  the running median by > 0.5 semitone for ≥ 3 frames; notes < 60 ms are merged into the
  closer-pitched neighbour. Glides of ≥ 1.5 semitones lasting ≥ 60 ms are not notes but
  become `slideIn` of the note they lead into (that note starts where the glide ends).
  Per note: `midi`/`cents`/`hzMedian` from the trimmed core, `stabilityCents` (std after
  removing a linear trend), `vibrato` (4–8 Hz periodicity with ≥ 20 cents peak-to-peak on
  notes ≥ 0.35 s), `loudnessDb` relative to the loudest note and the `dynamic` label,
  `run` (≥ 3 consecutive notes < 180 ms, mostly stepwise), `register` (separated mode only,
  energy of harmonics 1–2 vs 3–8). In `mix` mode, quiet notes more than an octave below
  the sung range are discarded as instrument pickup.
* **Phrases / breaths** (`analysis/phrases.py`) – gaps ≥ 0.25 s (and ≤ 4 s) between notes are
  breath points (time = middle of the gap) and set `breathBefore`; phrases split at those
  gaps, never merge across gaps ≥ 0.6 s, are capped at 12 s and phrases < 1 s or with
  < 2 notes are merged into a neighbour. Tags and a 1..5 difficulty follow the schema doc.
* **Song** (`analysis/features.py`) – key by Krumhansl–Schmuckler on the mean CQT chroma of
  the full mix (confidence = margin between the best and second-best correlation,
  normalised so that 0.25 → 1.0), tempo from `librosa.beat.beat_track`, range from the
  2nd/98th (lowMidi/highMidi) and 5th/95th percentiles of voiced-frame pitch.

## Tests

```bash
cd server
.venv/bin/python tests/test_pipeline.py                 # full run incl. HTTP smoke test
.venv/bin/python tests/test_pipeline.py --no-server     # pipeline only
.venv/bin/python tests/test_pipeline.py --no-separation # skip the (slow) Demucs job
```

`tests/make_test_song.py` renders a 30 s synthetic song (4 phrases, vibrato on the
long notes, one slide, one run, varying loudness over plucked chords) with ground
truth; `tests/test_pipeline.py` runs both analysis modes on it, checks the detected
notes/phrases/slides/vibrato against the truth, validates the JSON shape, unit-tests
the lyric aligner, the note snapping and the coach helpers (no network), then
starts uvicorn and exercises every endpoint: words (shape; the synthetic song has no
real words, so only that recognition runs and the shapes are right is asserted),
align, coach status/key/chat/plan (a live coach call when a key is available, else
the 401 message), and separation when Demucs is installed (a few minutes on CPU;
the synthetic voice is not recognised by Demucs, so this also checks the
`separationWeak` fallback). The smoke test uses a free port and a throw-away
secrets directory under `tests/out/`.
