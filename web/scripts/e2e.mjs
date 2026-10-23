// End-to-end smoke test with a fake microphone. Usage: node scripts/e2e.mjs <audioDir> <baseUrl>
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const [audioDir, baseUrl = 'http://localhost:4173'] = process.argv.slice(2);
const shots = path.join(audioDir, 'shots');
fs.mkdirSync(shots, { recursive: true });
const voice = path.join(audioDir, 'test-voice.wav');
const song = path.join(audioDir, 'test-song.wav');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${voice}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const expectServer = process.env.E2E_SERVER === '1';
page.on('console', (m) => {
  const text = m.text();
  // the health check against a stopped analysis server is expected noise
  if (!expectServer && /ERR_CONNECTION_REFUSED/.test(text)) return;
  if (m.type() === 'error') errors.push(`console: ${text}`);
});
const log = (...a) => console.log('[e2e]', ...a);

await page.goto(baseUrl + '/');
await page.waitForSelector('text=Welcome');
await page.screenshot({ path: path.join(shots, '01-onboarding.png') });
log('onboarding page rendered');

// Seed a finished profile straight into IndexedDB (the range test needs a live singer), then reload.
await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('voice-coach');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('profile', 'readwrite');
        tx.objectStore('profile').put({
          id: 'me',
          createdAt: Date.now(),
          name: 'Test',
          level: 'beginner',
          goals: ['sing-songs', 'range'],
          rangeTests: [{ date: Date.now() - 86400000, lowMidi: 50, highMidi: 74, voiceType: 'Tenor', accuracyCents: 20, stabilityCents: 15, accuracyScore: 80 }],
          calibration: { date: Date.now(), noiseFloorDb: -60, singingLevelDb: -25, gateDb: -52, latencyMs: 40, leakDetected: false, deviceLabel: 'fake' },
          allowOctave: true,
          onboardingDone: true,
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }),
);
await page.goto(baseUrl + '/');
await page.waitForSelector('text=Practise next');
await page.screenshot({ path: path.join(shots, '02-home.png') });
log('home rendered with plan');

// Calibration: does the worklet produce pitch from the fake mic?
await page.goto(baseUrl + '/calibration');
await page.click('text=Start the check');
await page.waitForSelector('text=Next: sing a note', { timeout: 15000 });
await page.click('text=Next: sing a note');
await page.waitForTimeout(1500);
const noteText = await page.locator('.big-note').first().innerText();
log('pitch meter during sing step shows:', noteText);
await page.waitForSelector('text=Microphone ready', { timeout: 15000 });
await page.screenshot({ path: path.join(shots, '03-calibration.png') });
if (!/^[A-G]#?\d$/.test(noteText.trim())) errors.push(`pitch meter did not show a note (got "${noteText}")`);

// Import a song, analysed in the browser (no server).
await page.goto(baseUrl + '/songs/new');
await page.setInputFiles('input[type=file]', song);
await page.waitForSelector('text=Analyse and start learning');
await page.fill('input[type=text] >> nth=0', 'Test Song');
await page.fill('input[type=text] >> nth=1', 'Synth Singer');
await page.fill('textarea', 'do re mi fa so\nso la high note down\nquick little run here\ntop and down to rest');
await page.screenshot({ path: path.join(shots, '04-import.png') });
if (expectServer) {
  await page.waitForSelector('text=Use the analysis server');
  log('server detected by the import page');
}
await page.click('text=Analyse and start learning');
await page.waitForURL(/\/practice\//, { timeout: 120000 });
await page.waitForSelector('.phrase-strip button');
const phraseCount = await page.locator('.phrase-strip button').count();
log('fallback analysis done, phrases:', phraseCount);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(shots, '05-practice.png') });
if (phraseCount < 3 || phraseCount > 6) errors.push(`unexpected phrase count ${phraseCount}`);

// Inspect the stored analysis
const info = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('voice-coach');
      req.onsuccess = () => {
        const tx = req.result.transaction('songs');
        tx.objectStore('songs').getAll().onsuccess = (e) => {
          const s = e.target.result[0];
          resolve({
            notes: s.analysis.notes.length,
            phrases: s.analysis.phrases.map((p) => ({ n: p.noteIds.length, text: p.text, tags: p.tags, start: p.start.toFixed(2) })),
            slides: s.analysis.notes.filter((n) => n.slideIn).length,
            vibrato: s.analysis.notes.filter((n) => n.vibrato).length,
            key: s.analysis.key,
            range: s.analysis.range,
            midis: s.analysis.notes.map((n) => n.midi).join(' '),
          });
        };
      };
    }),
);
log('analysis:', JSON.stringify(info));
if (expectServer) {
  // the separation job either upgrades the song or fails (no Demucs weights offline): the banner must say which
  await page.waitForSelector('.banner', { timeout: 10000 });
  const t0 = Date.now();
  let bannerText = '';
  while (Date.now() - t0 < 180000) {
    bannerText = (await page.locator('.banner').allInnerTexts()).join(' | ');
    if (!/Separating the vocal/.test(bannerText)) break;
    await page.waitForTimeout(3000);
  }
  log('server job outcome banner:', bannerText.slice(0, 160));
  const mode = await page.locator('.pill:has-text("Isolated vocal"), .pill:has-text("Fallback mode")').first().innerText();
  log('song mode after job:', mode);
}

// Listen, then sing (fake mic loops the voice file; we only check the pipeline runs and scores).
await page.click('button:has-text("Listen")');
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(shots, '06-listening.png') });
await page.waitForSelector('button:has-text("Sing")', { timeout: 20000 });
await page.click('button:has-text("Sing")');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(shots, '07-singing.png') });
await page.waitForSelector('text=One thing to change', { timeout: 30000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, '08-feedback.png') });
const fb = await page.locator('.score-ring .val').first().innerText();
const tip = await page.locator('text=One thing to change').locator('..').locator('h3').innerText();
log('phrase scored:', fb, '| tip:', tip);

// Loop mode: two passes then stop
await page.check('text=Loop the phrase');
await page.click('button:has-text("Sing")');
await page.waitForTimeout(9000);
await page.click('button:has-text("Stop")');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, '09-loop.png') });

// Speed 70% + key -2 rendering path
await page.click('.seg button:has-text("70%")');
await page.selectOption('select', { index: 9 }); // -2 semitones
await page.click('button:has-text("Listen")');
await page.waitForSelector('button:has-text("Sing")', { timeout: 30000 });
log('70% speed and transposed listen completed');

// Full run
await page.click('.seg button:has-text("Full run")');
await page.click('button:has-text("Sing the whole song")');
await page.waitForTimeout(3000);
await page.click('button:has-text("Stop")');
await page.waitForSelector('text=Practise the weakest phrase', { timeout: 10000 });
await page.screenshot({ path: path.join(shots, '10-fullrun.png') });
log('full run scored');

// Exercises
await page.goto(baseUrl + '/exercises');
await page.waitForSelector("text=Today's warm-up");
await page.screenshot({ path: path.join(shots, '11-exercises.png') });
await page.goto(baseUrl + '/exercise/pitch-match');
await page.waitForSelector('.phrase-strip button');
await page.click('button:has-text("Sing")');
await page.waitForSelector('text=One thing to change', { timeout: 30000 });
await page.screenshot({ path: path.join(shots, '12-exercise.png') });
log('exercise rep scored');
await page.goto(baseUrl + '/exercise/breathing');
await page.waitForSelector('text=Start');
await page.screenshot({ path: path.join(shots, '13-breathing.png') });

// Progress & recap
await page.goto(baseUrl + '/progress');
await page.waitForSelector('text=Phrase scores over time');
await page.screenshot({ path: path.join(shots, '14-progress.png'), fullPage: true });
await page.goto(baseUrl + '/');
await page.click('text=End session');
await page.waitForSelector('text=Session recap');
await page.screenshot({ path: path.join(shots, '15-recap.png') });
log('recap rendered');

await browser.close();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
console.log('\nE2E PASSED');
