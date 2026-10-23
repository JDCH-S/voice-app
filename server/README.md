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

## Run

```bash
cd server
.venv/bin/uvicorn main:app --port 8765
```

`GET /health` tells you whether separation is available:
`{"ok": true, "separation": "demucs" | "unavailable", "device": "cpu", "version": "0.1.0"}`.

Environment variables: `VOICE_JOBS_DIR` (job scratch dir, default `server/.jobs`),
`VOICE_MAX_UPLOAD_MB` (default 200), `DEMUCS_MODEL` (default `htdemucs`),
`DEMUCS_THREADS` (default 4), `DEMUCS_REPO` (offline model folder), `FFMPEG_BIN`.

## Endpoints

| method / path | what it does |
|---|---|
| `GET /health` | service status, whether Demucs is installed, device |
| `POST /analyze` | multipart form: `file` (any audio ffmpeg can read), `separate` = `"true"`/`"false"`. Returns `{ jobId }` immediately. |
| `GET /jobs/{id}` | `{ status, progress, message, meta, quickReady, finalReady, error }`. `status` goes `queued → decoding → quick → separating → finalizing → done` (or `failed`). `meta` = `{ title, artist, duration, tags }` from the file's tags (mutagen) or an `Artist - Title` filename. |
| `GET /jobs/{id}/analysis/quick` | `SongAnalysis` with `mode: "mix"` — computed from the full mix right after decoding, so practice can start while separation runs. 404 until `quickReady`. |
| `GET /jobs/{id}/analysis/final` | `SongAnalysis` with `mode: "separated"` — computed on the isolated vocal (adds `register`, cleaner melody). 404 unless `finalReady`. |
| `GET /jobs/{id}/stems/vocals`, `.../stems/instrumental` | mono stems, `audio/mpeg` (mp3, `-q:a 4`) or `audio/wav`. instrumental = mixture − vocals. |
| `DELETE /jobs/{id}` | removes the upload and every output. Jobs are purged automatically after 2 hours. |
| `POST /identify` | JSON `{ url }` → `{ title, artist, source: "youtube" \| "spotify" \| "unknown" }` from the public oEmbed endpoints only (no API keys, no audio download). 502 if the lookup fails. |
| `POST /lyrics/search` | JSON `{ title, artist, duration? }` → `{ found, synced (LRC), plain, title, artist, source: "lrclib" }` from lrclib.net. `found: false` when nothing matches, 502 if lrclib is unreachable. |

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
file contents are never logged. Nothing leaves the machine except the optional
metadata lookups (`/identify` → YouTube / Spotify oEmbed, `/lyrics/search` →
lrclib.net), which send only a URL or a title/artist/duration.

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
notes/phrases/slides/vibrato against the truth, validates the JSON shape, then
starts uvicorn and exercises every endpoint (separation included when Demucs is
installed, which takes a few minutes on CPU).
