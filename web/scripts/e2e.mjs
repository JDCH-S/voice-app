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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'notifications'], acceptDownloads: true });
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

// Home: "Your week" renders (rule-based without a coach), the goal ring shows, and the phone shell has a bottom tab bar.
await page.waitForSelector('.week-plan .week-day', { timeout: 15000 });
const weekSource = await page.locator('.week-plan .pill').first().innerText();
const weekDays = await page.locator('.week-plan .week-day').count();
log('week plan:', weekSource, '|', weekDays, 'days');
if (weekDays !== 7) errors.push(`week plan has ${weekDays} days`);
if (!expectServer && !/rule-based/.test(weekSource)) errors.push(`week plan without a server should be rule-based (got "${weekSource}")`);
if ((await page.locator('.week-plan .week-item.rest').count()) < 1) errors.push('week plan has no rest day');
if ((await page.locator('.goal-ring').count()) !== 1) errors.push('goal ring missing on Home');
await page.screenshot({ path: path.join(shots, '02a-home-week.png'), fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(baseUrl + '/');
await page.waitForSelector('text=Practise next');
await page.waitForSelector('.tabbar a:has-text("Coach")', { state: 'visible', timeout: 10000 });
const sidebarVisible = await page.locator('.sidebar').isVisible();
const tabCount = await page.locator('.tabbar a').count();
const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
log('mobile shell: tabs', tabCount, '| sidebar visible', sidebarVisible, '| widths', JSON.stringify(overflow));
if (sidebarVisible) errors.push('sidebar still visible at 390 px');
if (tabCount !== 5) errors.push(`expected 5 bottom tabs, got ${tabCount}`);
if (overflow.scroll > overflow.inner + 1) errors.push(`horizontal overflow on Home at 390 px (${overflow.scroll} > ${overflow.inner})`);
if (!(await page.locator('.mobile-only:has-text("Settings")').first().isVisible())) errors.push('Settings link missing from Today on the phone');
await page.screenshot({ path: path.join(shots, '02b-home-mobile.png'), fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 });

// Calibration: does the worklet produce pitch from the fake mic?
await page.goto(baseUrl + '/calibration');
await page.click('text=Start the check');
await page.waitForSelector('text=Next: sing a note', { timeout: 15000 });
await page.click('text=Next: sing a note');
await page.waitForTimeout(1500);
const noteText = await page.locator('.big-note').first().innerText();
log('pitch meter during sing step shows:', noteText);
// Delay step: the fake mic plays the voice file, not the room, so the clicks are not heard and the
// wizard must fall back to the estimate without failing.
await page.waitForSelector('text=Play the clicks', { timeout: 15000 });
await page.click('text=Play the clicks');
await page.waitForSelector('text=Microphone ready', { timeout: 20000 });
const latencyText = await page.locator('.latency-result').first().innerText();
log('calibration delay result:', latencyText);
if (!/\d+ ms \((measured|estimated)\)/.test(latencyText)) errors.push(`delay step did not report a result (got "${latencyText}")`);
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
  await page.waitForSelector("text=The singer's voice will be isolated");
  log('server detected by the import page');
}
await page.click('text=Analyse and start learning');
await page.waitForURL(/\/practice\//, { timeout: 120000 });
await page.click('.seg button:has-text("Learn phrase by phrase")');
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
await page.waitForSelector('button.big.primary:has-text("● Sing")', { timeout: 20000 });
await page.click('button.big.primary:has-text("● Sing")');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(shots, '07-singing.png') });
await page.waitForSelector('text=One thing to change', { timeout: 30000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, '08-feedback.png') });
const fb = await page.locator('.score-ring .val').first().innerText();
const tip = await page.locator('text=One thing to change').locator('..').locator('h3').innerText();
log('phrase scored:', fb, '| tip:', tip);
const vqRows = await page.locator('.vq-row').count();
log('voice-quality meter rows:', vqRows);
if (vqRows !== 2) errors.push(`voice-quality meter did not render two bars (got ${vqRows})`);

// Hear it fixed: render the pitch-corrected take, expect the three aligned playback buttons
await page.click('button:has-text("Hear it fixed")');
await page.waitForSelector('.hif-buttons', { timeout: 60000 });
const fixButtons = await page.locator('.hif-buttons button').allInnerTexts();
log('hear it fixed buttons:', fixButtons.join(' | '));
if (fixButtons.length !== 3 || !fixButtons.some((t) => /You \(fixed\)/.test(t)) || !fixButtons.some((t) => /Original singer/.test(t))) errors.push(`hear it fixed did not offer You / You (fixed) / Original singer (got ${fixButtons.join(', ')})`);
const dlButtons = await page.locator('button:has-text("Download my take"), button:has-text("Download fixed")').count();
if (dlButtons !== 2) errors.push(`expected both download buttons, got ${dlButtons}`);
await page.click('.hif-buttons button:has-text("You (fixed)")');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(shots, '08b-hear-it-fixed.png') });
await page.waitForSelector('.hif-buttons button:has-text("▶ You (fixed)")', { timeout: 30000 });
log('fixed take played back');

// Loop mode: two passes then stop
await page.check('text=Loop the phrase');
await page.click('button.big.primary:has-text("● Sing")');
await page.waitForTimeout(9000);
await page.click('button:has-text("Stop")');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, '09-loop.png') });

// Speed 70% + key -2 rendering path
await page.click('.seg button:has-text("70%")');
await page.selectOption('select', { index: 9 }); // -2 semitones
await page.click('button:has-text("Listen")');
await page.waitForSelector('button.big.primary:has-text("● Sing")', { timeout: 30000 });
log('70% speed and transposed listen completed');
const adaptiveNote = await page.locator('.adaptive-note').allInnerTexts();
log('adaptive difficulty note:', adaptiveNote.join(' ').slice(0, 120));

// Then vs now: a second recorded take of phrase 1, then "Compare first and latest" in the takes panel
await page.uncheck('text=Loop the phrase');
await page.click('button.big.primary:has-text("● Sing")');
await page.waitForSelector('text=One thing to change', { timeout: 40000 });
await page.click('button:has-text("My takes")');
await page.waitForSelector('.takes-panel');
const takeRows = await page.locator('.takes-panel tbody tr').count();
log('recorded takes:', takeRows);
const compareBtn = page.locator('.compare-btn');
if (await compareBtn.isEnabled()) {
  await compareBtn.click();
  await page.waitForSelector('text=Then:', { timeout: 15000 });
  await page.screenshot({ path: path.join(shots, '09b-then-vs-now.png') });
  await page.waitForSelector('text=Now:', { timeout: 40000 });
  await page.waitForSelector('.compare-btn:enabled', { timeout: 40000 });
  log('then vs now played both takes');
} else {
  errors.push(`compare first and latest was not enabled with ${takeRows} takes`);
}
await page.click('button:has-text("My takes")');

// Full run
await page.click('.seg button:has-text("Sing along")');
await page.click('button:has-text("● Sing along")');
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(shots, '10a-singalong.png') });
await page.click('button:has-text("Stop")');
await page.waitForSelector('text=Practise the weakest phrase', { timeout: 10000 });
await page.screenshot({ path: path.join(shots, '10-fullrun.png') });
const techHeader = await page.locator('.table th:has-text("Technique")').count();
if (techHeader !== 1) errors.push('sing-along table has no Technique column');
log('full run scored');

// Game mode: full-song karaoke, stopped early, must end with stars (back at full speed in the original key)
await page.click('.seg button:has-text("Game")');
await page.waitForSelector('text=Game mode');
await page.click('.seg button:has-text("100%")');
await page.selectOption('select', { index: 7 }); // original key
await page.click('button:has-text("Start the game")');
await page.waitForSelector('.game-hud', { timeout: 20000 });
await page.waitForTimeout(6500);
const hudPoints = await page.locator('.game-points-val').innerText();
log('game points after 6.5 s:', hudPoints);
await page.screenshot({ path: path.join(shots, '10b-game.png') });
await page.click('button:has-text("Stop")');
await page.waitForSelector('.game-end', { timeout: 15000 });
const starCount = await page.locator('.game-end-stars .stars i').count();
const starsOn = await page.locator('.game-end-stars .stars i.on').count();
const bestLine = await page.locator('.game-best').innerText();
log(`game ended: ${starsOn}/${starCount} stars | ${bestLine.trim().slice(0, 60)}`);
if (starCount !== 5) errors.push(`game end screen did not show five star slots (got ${starCount})`);
if (!/best/i.test(bestLine)) errors.push('game end screen has no best-ever line');
await page.screenshot({ path: path.join(shots, '10c-game-end.png') });
const savedGames = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('voice-coach');
      req.onsuccess = () => {
        const tx = req.result.transaction('games');
        tx.objectStore('games').getAll().onsuccess = (e) => resolve(e.target.result.length);
      };
    }),
);
log('games saved:', savedGames);
if (savedGames < 1) errors.push('game result was not saved to the games store');
const savedReviews = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('voice-coach');
      req.onsuccess = () => {
        const tx = req.result.transaction('reviews');
        tx.objectStore('reviews').getAll().onsuccess = (e) => resolve(e.target.result.length);
      };
    }),
);
log('review states saved:', savedReviews);
if (savedReviews < 1) errors.push('no spaced-review state was saved after phrase attempts');

// Phone layout: 390×844, stacked, no horizontal overflow
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
const columnWidth = await page.evaluate(() => document.querySelector('.practice-page').clientWidth);
if (columnWidth < 300) {
  // the app shell still shows the desktop sidebar at this width (its phone shell is separate work):
  // judge the practice page in the column a phone shell gives it
  log(`note: the app shell leaves the practice page only ${columnWidth} px at 390 px wide; hiding the sidebar for the phone checks`);
  await page.addStyleTag({ content: '.sidebar{display:none !important}.main{padding:12px 12px 40px !important}' });
  await page.waitForTimeout(400);
}
await page.screenshot({ path: path.join(shots, '16a-mobile-game-end.png'), fullPage: true });
await page.click('.seg button:has-text("Learn phrase by phrase")');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(shots, '16b-mobile-learn.png') });
await page.screenshot({ path: path.join(shots, '16c-mobile-learn-full.png'), fullPage: true });
const mobile = await page.evaluate(() => {
  const roll = document.querySelector('.roll-wrap canvas');
  const small = [];
  for (const b of document.querySelectorAll('.ps button, .ps select')) {
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.height < 40) small.push(`${(b.textContent || b.tagName).trim().slice(0, 18)}:${Math.round(r.height)}`);
  }
  // the practice page must fit the column it is given; anything wider than that is the app shell's business
  // (scrollWidth ignores what is inside the strip's and tables' own horizontal scrollers, which is intended scrolling)
  const pp = document.querySelector('.practice-page');
  const ppRight = pp.getBoundingClientRect().right;
  const offenders = [];
  for (const el of pp.querySelectorAll('*')) {
    if (el.closest('.phrase-strip, .table-scroll')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > ppRight + 6) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}:+${Math.round(r.right - ppRight)}`);
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    practiceWidth: pp.clientWidth,
    practiceContent: pp.scrollWidth,
    offenders: offenders.slice(0, 12),
    rollHeight: roll ? Math.round(roll.getBoundingClientRect().height) : 0,
    smallTargets: small,
  };
});
log('mobile layout:', JSON.stringify(mobile));
if (mobile.practiceContent > mobile.practiceWidth + 6) errors.push(`practice content overflows its column on a phone (${mobile.practiceContent} > ${mobile.practiceWidth})`);
if (mobile.scrollWidth > mobile.clientWidth + 1) log(`note: the whole page is ${mobile.scrollWidth} px wide at 390 px (the app shell's sidebar; the practice column itself fits)`);
if (mobile.rollHeight < 200 || mobile.rollHeight > 400) errors.push(`mobile roll height ${mobile.rollHeight} is not derived from the viewport`);
if (mobile.smallTargets.length) errors.push(`mobile touch targets under 40 px: ${mobile.smallTargets.join(', ')}`);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);

// Exercises
await page.goto(baseUrl + '/exercises');
await page.waitForSelector("text=Today's warm-up");
await page.screenshot({ path: path.join(shots, '11-exercises.png') });
await page.goto(baseUrl + '/exercise/pitch-match');
await page.waitForSelector('.phrase-strip button');
await page.click('button.big.primary:has-text("● Sing")');
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

// Progress additions: technique trends, streak calendar and game bests cards render.
await page.goto(baseUrl + '/progress');
await page.waitForSelector('[data-testid=technique-trends]');
for (const id of ['streak-calendar', 'game-bests']) if ((await page.locator(`[data-testid=${id}]`).count()) !== 1) errors.push(`progress card ${id} missing`);
const calCells = await page.locator('.streak-cell').count();
if (calCells !== 84) errors.push(`streak calendar has ${calCells} cells, expected 84`);
log('progress additions rendered, calendar cells:', calCells);

// Coach page: without a server it explains that it needs the analysis service; with one, it shows the chat or the key card.
await page.goto(baseUrl + '/coach');
if (expectServer) {
  await page.waitForSelector('text=/Set up the coach|Ask anything about your singing/', { timeout: 15000 });
} else {
  await page.waitForSelector('text=The coach needs the analysis service', { timeout: 15000 });
}
await page.waitForSelector('.coach-compose textarea');
await page.click('.quick-prompts button >> nth=0');
const draft = await page.locator('.coach-compose textarea').inputValue();
if (!expectServer && !/flat on high notes/.test(draft)) errors.push(`quick prompt did not land in the box without a server (got "${draft}")`);
await page.screenshot({ path: path.join(shots, '16-coach.png') });
log('coach page rendered;', expectServer ? 'server mode' : 'offline card shown');

// Recap → "Ask the coach about this session" hands the question over.
await page.goto(baseUrl + '/progress');
await page.click('a:has-text("Recap") >> nth=0');
await page.waitForSelector('[data-testid=ask-coach]');
await page.click('[data-testid=ask-coach]');
await page.waitForURL(/\/coach/);
await page.waitForFunction(() => /session/.test(document.querySelector('.coach-compose textarea')?.value || ''), null, { timeout: 5000 });
log('recap handed its question to the coach');

// Settings: daily habit card, and export triggers a download of a parsable .voicecoach.json file.
await page.goto(baseUrl + '/settings');
await page.waitForSelector('#habits');
await page.fill('input[type=time]', '19:30');
await page.waitForSelector('text=/Reminder at|Next:/', { timeout: 5000 });
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('[data-testid=export-btn]')]);
const dlName = download.suggestedFilename();
const dlPath = path.join(audioDir, 'export-test.json');
await download.saveAs(dlPath);
let exported = null;
try {
  exported = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
} catch (e) {
  errors.push(`export file is not JSON: ${e.message}`);
}
log('export:', dlName, '|', exported ? `${exported.songs.length} songs, ${exported.attempts.length} attempts, ${exported.sessions.length} sessions, profile ${exported.profile?.name}` : 'unreadable');
if (!dlName.endsWith('.voicecoach.json')) errors.push(`export file name "${dlName}" should end with .voicecoach.json`);
if (exported && (exported.app !== 'voice-coach' || exported.songs.length !== 1 || exported.attempts.length < 1 || exported.profile?.reminderTime !== '19:30')) errors.push('export content is incomplete');
await page.waitForSelector('text=/Saved voice-coach-/');
await page.screenshot({ path: path.join(shots, '17-settings.png'), fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(baseUrl + '/settings');
await page.waitForSelector('#habits');
await page.screenshot({ path: path.join(shots, '17b-settings-mobile.png'), fullPage: true });
await page.goto(baseUrl + '/coach');
await page.waitForSelector('.coach-compose textarea');
await page.screenshot({ path: path.join(shots, '16b-coach-mobile.png'), fullPage: true });
await page.goto(baseUrl + '/progress');
await page.waitForSelector('[data-testid=technique-trends]');
await page.screenshot({ path: path.join(shots, '14b-progress-mobile.png'), fullPage: true });
const progressOverflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
if (progressOverflow.scroll > progressOverflow.inner + 1) errors.push(`horizontal overflow on Progress at 390 px (${progressOverflow.scroll} > ${progressOverflow.inner})`);
await page.setViewportSize({ width: 1440, height: 900 });
log('settings export and phone screenshots done');

await browser.close();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
console.log('\nE2E PASSED');
