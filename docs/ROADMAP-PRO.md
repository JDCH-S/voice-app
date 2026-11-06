# Voice Coach: the "professional coach" build

Goal: the best singing-coach app for anyone, from first note to professional level. This document is the
brief for the engineers (human or agent) building the next wave. Read it fully before touching code.

## Ground rules for every package

* Read `README.md`, `docs/ANALYSIS_SCHEMA.md`, `web/src/lib/types.ts` first. The types for every new feature
  (voice-quality fields on `PitchFrame`, `WordTiming`, `ReviewState`, `AdaptiveSettings`, `GameResult`,
  `CoachThread`, `WeeklyPlan`, new `IssueKind`s) are **already defined** there, and `web/src/lib/store/db.ts`
  already has the `games`, `coachThreads` and `reviews` stores (DB version 2). Build on them; add fields only
  additively and only if truly needed.
* Language in the UI: plain words a beginner understands. Honest feedback: say what was wrong and how to fix it.
* Privacy: everything stays local unless the user explicitly uses the coach or lyric lookup. Never log audio.
* No new dependencies unless clearly necessary; list every one you add in your report. Plain CSS.
* Before you finish: `cd web && npm run typecheck && npx tsx scripts/selftest.ts && npm run build`.
  Server changes: `cd server && .venv/bin/python tests/test_pipeline.py --no-server` (and the HTTP smoke test if
  you changed endpoints). Extend the tests for what you built.
* Working in a git worktree: `node_modules` and `.venv` are not in git. Symlink them from the main checkout before
  building: `ln -s /home/user/voice-app/web/node_modules web/node_modules` and
  `ln -s /home/user/voice-app/server/.venv server/.venv`. Never commit them. Chromium for Playwright is at
  `/opt/pw-browsers/chromium` (`CHROMIUM_PATH`). Test audio: `web/scripts/make_test_audio.py`.
* Commit on your worktree branch with clear messages; report the branch name and the final commit SHA.
* Stay inside your package's files (listed per package). If you must touch a shared file, keep the change
  minimal and additive and call it out in your report.

## Package A: audio core (trustworthy pitch and voice quality)

Files: `web/public/pitch-worklet.js`, `web/src/lib/audio/MicAnalyzer.ts`, `web/src/lib/audio/voiceQuality.ts`
(new), `web/src/components/CalibrationWizard.tsx`, `web/src/lib/useMic.ts`.

1. **Probabilistic pitch tracking.** Replace "first YIN dip under threshold" with pYIN-style candidate
   generation (all dips, each with a probability from a threshold distribution) and a Viterbi/HMM smoothing
   over a short lookahead (≤ 3 frames, ≤ 35 ms added latency) with a pitch-transition prior and a voiced/unvoiced
   state. Octave errors must drop sharply on breathy and quiet input; emit `voicing` 0..1. Keep CPU cheap
   (the diff function is already computed; reuse it).
2. **Voice-quality features per frame**, computed in the worklet from the same window: `hnr` (dB, from the YIN
   aperiodicity: HNR ≈ 10·log10((1−d′min)/d′min)), `centroid` and `tilt` (dB/octave, from a small FFT or a
   bank of a few band energies), `breathiness` 0..1 (low HNR + steep tilt), `pressed` 0..1 (bright tilt + high
   level + high pitch relative to the singer's range: pass `highMidi` into the analyser). Put the formulas in
   `voiceQuality.ts` with unit tests in `web/scripts/selftest.ts` (synthesise a clean sawtooth, a noisy breathy
   tone and a bright pressed tone and check the ordering).
3. **Measured audio delay** in `CalibrationWizard`: a new step that measures the real round-trip latency by
   playing 4 clicks and detecting them in the mic (onset detection on the energy envelope, median offset). With
   headphones on the mic hears nothing, so the step tells the user to take the headphones off (or hold one
   earcup to the mic) for five seconds, and falls back to the estimate when no click is detected, saying so.
   Store the result in `MicCalibration.latencyMs` and surface it in Settings text.
4. Update the live meter smoothing in `MicAnalyzer` to use the new voicing probability instead of the ad-hoc
   median guard, keeping the public `RawPitch` shape (new optional fields are already declared).

## Package B: technique analysis and learning logic (pure TypeScript, unit-tested)

Files: `web/src/lib/scoring/score.ts`, `web/src/lib/scoring/technique.ts` (new), `web/src/lib/adaptive.ts`
(new), `web/src/lib/review.ts` (new), `web/src/lib/game.ts` (new), `web/src/lib/habits.ts` (new),
`web/src/lib/audio/pitchCorrect.ts` (new), `web/src/lib/plan.ts`, `web/src/lib/exercises/library.ts`,
`web/scripts/selftest.ts`.

1. **Technique detection** (`technique.ts`), from `PitchFrame[]` plus the reference notes, producing
   `NoteIssue`s of kind `breathy`, `strain`, `crack`, `out-of-air` (tips already exist in `score.ts`):
   breathy = median `breathiness` over a note ≥ 0.6 (or `hnr` < 8 dB) on notes ≥ 0.3 s; strain = `pressed`
   ≥ 0.7 sustained ≥ 0.25 s, or clipping peaks on high notes; crack = inside a note ≥ 0.4 s, a pitch jump ≥ 5
   semitones lasting ≥ 40 ms with a voicing dropout or clarity collapse around it; out-of-air = on notes ≥ 1 s,
   level drops ≥ 8 dB over the last 40% while pitch sags ≥ 25 cents. Fields may be undefined (older frames):
   degrade gracefully. Wire it into `scorePhrase` (expression bucket, with a separate `technique` summary field
   added additively to the returned object) and `pickTip`.
2. **Adaptive difficulty** (`adaptive.ts`): `nextSettings(attempts for this phrase, current settings, level)
   → AdaptiveSettings` with a one-sentence reason. Rules: two scores < 60 → slow one step and turn the guide on;
   two ≥ 85 at the current settings → speed up one step, then guide off; never slower than 50%; respect the
   level (advanced starts at 100%, guide off). Also `masteryFor(scores[])`.
3. **Spaced review** (`review.ts`): SM-2-lite. `updateReview(prev | null, score, now) → ReviewState`
   (intervals 1, 3, 7, 14, 30 days scaled by score; a score < 70 resets to 1 day) and
   `dueReviews(states, now, limit)`. Add "Review" items to `buildPlan` in `plan.ts` (keep its signature;
   add an optional `reviews` argument).
4. **Pitch-corrected replay** (`pitchCorrect.ts`): `pitchCorrectTake(recording: AudioBuffer, frames,
   analysis, { semitones, startSongTime, tempo }) → Promise<AudioBuffer>`: per reference note, take the sung
   region (use the attempt's note results or recompute the median cents error from frames), shift that region
   by −error with the existing `renderVariant` machinery (WSOLA stretch + resample) and crossfade 10 ms at the
   joins; unvoiced regions untouched; output has the same length/timeline as the input so it plays in sync with
   the original. Octave-shifted singing is corrected only to the nearest octave (never jump an octave).
5. **Karaoke game** (`game.ts`): a `KaraokeScorer` fed live frames and the reference: running points (per
   on-pitch frame, weighted by note duration), a combo that grows while on pitch and breaks when off for
   > 0.3 s, a multiplier up to ×4, `starsFor(score)` (≥ 95 → 5, 85 → 4, 70 → 3, 55 → 2, 35 → 1), per-phrase
   stars, and a final `GameResult` (type exists). Pure logic, no DOM.
6. **Habits** (`habits.ts`): `streakDays(sessions, now)`, `todayMinutes(sessions, now)`,
   `dailyGoalMinutes(profile)` (default 10), `nextReminderAt(profile, now)`.
7. **Then vs now**: `firstAndLatest(recordings, phraseIndex | null)` helper (put it in `review.ts`).
8. Extend `selftest.ts` with tests for every function above (synthesise frames). Keep all existing tests
   passing.

## Package C: analysis service additions (Python) and deployment

Files: `server/**`, `web/src/lib/api.ts` (additive functions only), `Dockerfile`, `docker-compose.yml`,
`docs/DEPLOY.md`.

1. **Word timing** with speech recognition: optional dependency `faster-whisper` (add
   `server/requirements-words.txt`; lazy import; model size from `VOICECOACH_WHISPER_MODEL`, default `small`;
   CPU int8). After the final (or quick, if no separation) analysis, run it on the isolated vocal (or mix) with
   word timestamps and store `words: WordTiming[]` (schema in `types.ts`) in the job; serve at
   `GET /jobs/{id}/words` (404 until ready, 503 with a clear message when whisper is not installed). Job status
   gets `wordsReady: bool`. `POST /jobs/{id}/align` with JSON `{ lyrics: string }` returns the user's own lyric
   text aligned to the recognised timing (sequence-align the words with `difflib`, keep the user's spelling,
   interpolate timing for unmatched words). `/health` reports `whisper: true|false`. Weights download from
   huggingface.co on first use; that host is allowed in this environment, so test it for real on the synthetic
   test song (it has no real words, so also synthesise or record nothing: it is fine if the test only asserts
   the endpoint shape and that recognition runs without error; say so).
2. **AI coach**: `POST /coach` JSON `{ messages: [{role, content}], context: {...} }` → `{ reply }`, and
   `POST /coach/plan` JSON `{ context }` → `WeeklyPlan` JSON (use structured output / a JSON schema so the
   shape is guaranteed), plus `GET /coach/status` → `{ available, model, keySource }` and `POST /coach/key`
   `{ key }` which stores the key in `server/.secrets/anthropic_key` (mode 600; `.secrets/` git-ignored).
   Before writing any of this, invoke the `claude-api` skill and follow it for model ids, the Messages API and
   structured output. Default model `claude-sonnet-5-5` (configurable via `VOICECOACH_COACH_MODEL`). Key
   resolution: env `ANTHROPIC_API_KEY`, else the saved file, else **still attempt the call without a key** (in
   this development environment the proxy authenticates requests to api.anthropic.com itself, so the live test
   works here without a key; on a user's machine the call then fails with 401 and the API must return a clear
   "add your key in Settings" message). System prompt: a warm, honest professional vocal coach; concrete,
   short answers; always names the exercise to do; vocal-health first (never push through pain); uses the
   context numbers (range, scores, issues) explicitly; never invents data that is not in the context. Limit
   context size (last 30 attempts, summarised). Never log message content. Test live: one `/coach` call and
   one `/coach/plan` call must succeed here and the plan must validate against the schema.
3. **Deployment**: multi-stage `Dockerfile` (node build of `web/`, python runtime with ffmpeg via
   `imageio-ffmpeg`, base + separation + words requirements, non-root user, `VOICECOACH_WEB_DIST` pointing at
   the built app, port 8765), `docker-compose.yml` with a volume for `.jobs` and `.secrets`, and `docs/DEPLOY.md`
   explaining: HTTPS is required for microphone access in browsers, how to run on a VPS with Caddy for TLS,
   CPU/RAM needs, and that hosting for many users needs a GPU box for separation. Make `allow_origins`
   configurable (`VOICECOACH_ORIGINS`). Build the image if docker is available here; otherwise say it was not
   built.
4. Add the API client functions in `web/src/lib/api.ts`: `jobWords`, `alignLyrics` (server), `coachStatus`,
   `coachChat`, `coachPlan`, `setCoachKey`. Types from `types.ts`.
5. Tests: extend `server/tests/test_pipeline.py` (words endpoint shape, coach status, coach call) and the
   HTTP smoke test. Document every endpoint in `server/README.md` and `docs/ANALYSIS_SCHEMA.md`.

## Package D: practice experience (after A, B, C are merged)

Files: `web/src/components/PracticeSession.tsx`, `web/src/components/PianoRoll.tsx`,
`web/src/components/FeedbackPanel.tsx`, `web/src/components/PitchMeter.tsx`, `web/src/pages/Practice.tsx`,
new components under `web/src/components/practice/`, `web/src/styles-practice.css` (new, import it from
`main.tsx`), `web/src/lib/analysis/lyrics.ts` (word-level alignment), `web/src/lib/songJobs.ts` (fetch words).

1. **Live voice-quality meter** next to the pitch meter: two small bars, "airy ↔ clear" (breathiness) and
   "relaxed ↔ pushed" (pressed), with a plain-words hint when either is in the red for > 1 s.
2. **Technique feedback** in `FeedbackPanel` (the new issue kinds), with their tips and exercise links.
3. **Auto-adjust difficulty** (default on, toggle in the settings row): after each phrase attempt apply
   `nextSettings` and show the reason in one line ("Slowed to 70% and turned the guide on. You'll get it.").
4. **Hear it fixed**: after a take, "Hear it fixed" renders `pitchCorrectTake` and offers three aligned
   playback buttons: You, You (fixed), Original singer, plus "Download my take" (webm) and "Download fixed" (wav).
5. **Then vs now**: in the takes panel, "Compare first and latest" plays the first and latest take of the
   current phrase back to back with their trails on the roll.
6. **Game mode**: a third mode next to Sing along and Learn: full-song karaoke with a live points counter,
   combo ×N badge, per-phrase stars popping on the roll, an end screen with stars and best-ever, saved to the
   `games` store. Keep it clearly playful and separate from the honest practice scores.
7. **Word-level lyrics**: when `song.words` exists, align words to notes by time (`alignWords` in
   `lyrics.ts`), draw each word at its true time, and highlight the current word while playing. `songJobs.ts`
   fetches `/jobs/{id}/words` when ready and stores them on the song.
8. **Phones and small screens**: PracticeSession must work at 390×844 (stacked layout, roll height from the
   viewport, 44 px touch targets, no hover-only controls, no accidental double-tap zoom) and at 1440×900.
   Add a mobile screenshot to `web/scripts/e2e.mjs` and keep the e2e passing.

## Package E: app shell, coach, habits (after A, B, C are merged; runs alongside D)

Files: `web/src/App.tsx`, `web/src/pages/Home.tsx`, `web/src/pages/Progress.tsx`, `web/src/pages/Settings.tsx`,
`web/src/pages/Recap.tsx`, `web/src/pages/Exercises.tsx`, `web/src/pages/ExerciseRun.tsx`,
`web/src/pages/Library.tsx`, `web/src/pages/ImportSong.tsx`, `web/src/pages/Coach.tsx` (new),
`web/src/components/shell/*` (new), `web/src/styles-app.css` (new, import from `main.tsx`),
`web/src/lib/store/export.ts` (new), `web/src/lib/notifications.ts` (new), `web/src/lib/coachContext.ts` (new).

1. **Coach page** (`/coach`): chat threads (stored in `coachThreads`), quick prompts ("Why do I go flat on
   high notes?", "Plan my week", "Is this song too hard for me?"), context assembled by `coachContext.ts`
   (profile, range, last 30 attempts summarised, weakest criterion, dominant issues, songs). When
   `/coach/status` says unavailable: a friendly setup card with a key field (posts to `/coach/key`). "Ask the
   coach about this session" link from `Recap`.
2. **Your week** on Home: a weekly plan from `/coach/plan`, cached per week in `settings`; falls back to the
   rule-based plan. Due reviews ("Due today") from `review.ts`; daily goal ring and streak; reminder time in
   Settings using the Notification API (ask permission; fire while the app is open; say honestly that closed
   tabs cannot remind).
3. **Export / import** all data (`export.ts`): one `.voicecoach.json` file (profile, songs with analysis,
   attempts, sessions, reviews, games, exercise results) with an "include recordings and audio" option that
   embeds blobs as base64; import merges by id. Buttons in Settings.
4. **Mobile shell**: the sidebar becomes a bottom tab bar under 900 px; every page usable at 390 px wide.
5. **Progress**: technique trends (breathiness, pressed over time from attempt frames), streak calendar (last
   12 weeks), game bests per song; keep charts to one axis, validated colours (indigo `#4f46e5`, amber
   `#d97706`), hover tooltips.
6. **Import page**: option "Find the words with speech recognition" (default on when the server has whisper);
   show word-alignment status on the song card in Library.

## Package F: review and verification (after D and E are merged)

Adversarial review of the whole diff (correctness, audio timing, beginner UX, privacy, mobile), run the e2e at
both viewports with the server up, fix what is found, update `README.md` and this roadmap's status.

## Not in this wave (needs business decisions, not code)

Hosted multi-user service with accounts (needs a provider, costs and a privacy policy; the Dockerfile and
export/import prepare for it), licensed song catalogue, native phone apps.
