# Song analysis contract

Both the Python analysis service (`server/`) and the browser fallback analyser
(`web/src/lib/analysis/`) produce the same JSON object, `SongAnalysis`.
The TypeScript source of truth is `web/src/lib/types.ts`.

## SongAnalysis

| field | type | meaning |
|---|---|---|
| `version` | `1` | schema version |
| `mode` | `"separated" \| "mix"` | `separated`: features come from the isolated vocal. `mix`: fallback, features come from the full mix (less accurate). |
| `duration` | number | seconds |
| `key` | `{ tonic: "C".."B" (sharps), mode: "major"\|"minor", confidence: 0..1 } \| null` | original key of the recording (Krumhansl profile on chroma of the full mix) |
| `tempoBpm` | number \| null | estimated tempo |
| `melody` | `{ t0: number, hop: number, hz: number[], rmsDb: number[] }` | frame-wise reference f0 of the vocal. `hz[i]` is 0 when unvoiced. Frame i is at `t0 + i*hop` seconds. `rmsDb` is dBFS of the vocal frame (negative, −100 when silent). Hop ≈ 0.0116 s (256/22050). |
| `notes` | `RefNote[]` | note-by-note reference performance, sorted by start |
| `phrases` | `Phrase[]` | practice sections |
| `breaths` | number[] | times (s) of detected breath points (gaps ≥ 0.25 s between voiced regions, within sung sections) |
| `range` | `{ lowMidi, highMidi, p05, p95 }` | MIDI numbers (floats OK). p05/p95 are percentiles of voiced frame pitch, used to recommend a key. |
| `warnings` | string[] | human readable notes (e.g. "Vocal separation unavailable; melody extracted from the full mix.") |

## RefNote

| field | type | meaning |
|---|---|---|
| `id` | number | 0-based, equals index in `notes` |
| `start`, `end` | number | seconds in the original recording |
| `midi` | number (int) | nearest MIDI note (A4 = 69 = 440 Hz) |
| `cents` | number | median deviation from `midi` in cents, −50..50 |
| `hzMedian` | number | median f0 |
| `stabilityCents` | number | std-dev of f0 in cents within the note core (after removing vibrato trend) |
| `slideIn` | `{ fromMidi: number, duration: number } \| null` | the note is approached by a glide (portamento/scoop) of ≥ 1.5 semitones lasting ≥ 60 ms, within one continuous voiced region |
| `run` | boolean | part of a melisma/run: ≥ 3 consecutive notes each < 180 ms, mostly stepwise |
| `vibrato` | `{ rate: number, extentCents: number } \| null` | detected on notes ≥ 0.35 s: periodic 4–8 Hz modulation with peak-to-peak extent ≥ 20 cents |
| `loudnessDb` | number | mean RMS of the note in dB relative to the loudest note of the song (0 = loudest) |
| `dynamic` | `"pp"\|"p"\|"mp"\|"mf"\|"f"\|"ff"` | from `loudnessDb`: ≥ −3 ff, ≥ −7 f, ≥ −12 mf, ≥ −18 mp, ≥ −26 p, else pp |
| `breathBefore` | boolean | a breath point immediately precedes this note |
| `register` | `"chest"\|"head"\|"mixed"\|null` | heuristic from harmonic energy distribution; null when `mode` = `mix` or undecidable |
| `lyric` | string \| null | word(s) assigned to this note; filled by the frontend lyric aligner, null from the analyser |
| `phrase` | number | index into `phrases` |

## Phrase

| field | type | meaning |
|---|---|---|
| `index` | number | 0-based |
| `start`, `end` | number | seconds (start = first note start − 0.05, end = last note end + 0.05, clamped) |
| `noteIds` | number[] | notes in this phrase |
| `text` | string | lyric text (frontend fills in; analyser leaves "") |
| `difficulty` | number | 1..5 |
| `tags` | string[] | any of `high-note`, `low-note`, `long-hold`, `run`, `wide-leap`, `slide`, `vibrato`, `fast` |

Phrase rules: split the voiced timeline at gaps ≥ 0.25 s (breath points) and at
gaps ≥ 0.6 s always; cap a phrase at 12 s by splitting at its largest internal
gap; merge phrases shorter than 1.0 s or with < 2 notes into a neighbour.

## WordTiming

Word-level timing from speech recognition on the (isolated) vocal. `SongRecord.words` holds
them once fetched; the frontend matches them to notes by time.

| field | type | meaning |
|---|---|---|
| `t0`, `t1` | number | start / end in seconds of the original recording. `t0` is snapped to the nearest melody note onset within 0.6 s by the service. |
| `text` | string | the word as recognised (or, from `/align`, exactly as the user wrote it) |
| `conf` | number 0..1 | recognition probability; 0 for a word whose timing was interpolated by `/align` |

## WeeklyPlan (AI coach)

`POST /coach/plan` returns the `WeeklyPlan` of `types.ts`: `{ weekStart (epoch ms, Monday 00:00
local, copied from the request's `context.weekStart`), summary, days: exactly 7 `{ day: "Mon".."Sun",
focus, items: [{ kind: "exercise"|"song"|"phrase"|"rest"|"range-test", title, exerciseId, songId,
phraseIndex, minutes }] }`, source: "coach" }`. `exerciseId` / `songId` are always ids present in the
request context (else `null`); a day never exceeds 25 minutes.

## Analysis service HTTP API (default `http://localhost:8765`)

* `GET /health` → `{ ok: true, separation: "demucs" | "unavailable", device: "cpu"|"cuda"|"mps", version, whisper: boolean, whisperModel: string|null, coach: boolean }`
* `POST /analyze` (multipart form: `file` audio, `separate` = "true"|"false", `words` = "true"|"false", default true) → `{ jobId }`
* `GET /jobs/{jobId}` → `{ status, progress, message, meta, quickReady, finalReady, wordsReady, wordsError, separationWeak, error }`
  * `status`: `queued | decoding | quick | separating | finalizing | done | failed`
  * `progress`: 0..1 overall
  * `meta`: `{ title: string|null, artist: string|null, duration: number, tags: {...id3} }`
  * `quickReady`: the fallback (`mode: "mix"`) analysis is ready — the user can start practising while separation continues
  * `finalReady`: the separated analysis and stems are ready
  * `wordsReady`: `GET /jobs/{jobId}/words` will answer. It turns true together with `finalReady` (separation jobs) or `quickReady` (no separation), never later, so deleting the job at that point loses nothing. `wordsError`: string|null, why words are missing (`"not requested"`, model missing, ...)
  * `separationWeak`: the isolated vocal was nearly silent (RMS < −45 dBFS) or produced fewer than 40 % of the mix analysis' notes; the stems are still served but `/analysis/final` is then the mix analysis (`mode: "mix"`) with the warning `"Vocal separation found very little voice in this file; using the full-mix melody"`
* `GET /jobs/{jobId}/analysis/quick` and `/analysis/final` → `SongAnalysis`
* `GET /jobs/{jobId}/stems/vocals` and `/stems/instrumental` → audio file (mono, mp3 if an encoder is available else wav); `Content-Type` set accordingly
* `GET /jobs/{jobId}/words` → `{ words: WordTiming[], language: string|null, languageProbability: number, model: string }`; 404 until `wordsReady`, 503 (with a readable `detail`) when faster-whisper is not installed or its model could not be loaded
* `POST /jobs/{jobId}/align` JSON `{ lyrics: string }` → `{ words: WordTiming[], matched: number, total: number }`: the user's own text aligned to the recognised timing, one entry per word in the user's order and spelling (same 404/503 rules)
* `DELETE /jobs/{jobId}` → removes the uploaded file and all outputs (the frontend calls this once it has stored the stems locally). Jobs are also purged automatically after 2 hours.
* `POST /identify` JSON `{ url }` → `{ title, artist, source: "youtube"|"spotify"|"unknown" }` using the public oEmbed endpoints only (no API keys, no audio download).
* `POST /lyrics/search` JSON `{ title, artist, duration? }` → `{ found: boolean, synced: string|null (LRC), plain: string|null, title, artist, source: "lrclib" }`
* `GET /coach/status` → `{ available: boolean, model: string, keySource: "env"|"file"|"none", message?: string }`
* `POST /coach/key` JSON `{ key }` → the same status object (the key is stored server-side with mode 600; an empty key removes it)
* `POST /coach` JSON `{ messages: [{ role: "user"|"assistant", content }], context }` → `{ reply: string }`; errors carry `{ detail }` (401 = no working key: "add your Anthropic API key in Settings")
* `POST /coach/plan` JSON `{ context }` → `WeeklyPlan`

The service never keeps user audio beyond the job lifetime and does not log file contents or coach messages. Only `/identify`, `/lyrics/search` and the `/coach*` endpoints talk to the internet (and only when the user uses them).
