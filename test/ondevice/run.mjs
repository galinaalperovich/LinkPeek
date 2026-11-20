// On-device test: the real extension, the real Google Chrome and Chrome's real
// built-in model (Gemini Nano). No mock stands in for the model, so this
// checks the one thing the other tests cannot: that "Keyless" really works on
// this computer, and that its summaries have the shape LinkPeek promises.
//
//   npm run test:ondevice                    no window: Chrome runs headless
//   HEADED=1 npm run test:ondevice           watch it in a Chrome window
//   FRESH=1 npm run test:ondevice            start from a new Chrome profile
//   ALLOW_DOWNLOAD=1 npm run test:ondevice   let Chrome download the model (a few GB) if needed
//   CHROME_PATH=/path/to/chrome npm run test:ondevice
//
// It is not part of CI: it needs Google Chrome 138 or newer and a computer
// that can run the model (see README, "No key needed").
//
// How it works. Chrome is started with a profile of its own (your own Chrome
// profile is never opened) and with plain flags: the flags that browser
// automation tools add by default switch off the service that runs the model,
// and then Chrome never answers. FRESH=1 starts from a new profile, which is
// what exercises the first-run path: the model switched on by the first X+click. The model is several GB, so if your own Chrome has
// already downloaded it, the files are copied into the test profile (a
// copy-on-write clone where the file system can do that) instead of being
// downloaded again. Chrome no longer accepts --load-extension, so the unpacked
// extension is loaded through the DevTools protocol pipe.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../e2e/server.mjs';
import { attach, sleep, waitFor } from '../e2e/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : ROOT;
const PROFILE = path.join(tmpdir(), 'linkpeek-ondevice-profile');
const MODEL_DIR = 'OptGuideOnDeviceModel';
// Waking the model takes 10 to 25 seconds on a fast laptop.
const SLOW = 120_000;

function findChrome() {
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
    win32: [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  }[platform()] || [];
  return [process.env.CHROME_PATH, ...candidates].find((file) => file && existsSync(file));
}

function ownProfileDir() {
  return {
    darwin: path.join(homedir(), 'Library/Application Support/Google/Chrome'),
    linux: path.join(homedir(), '.config/google-chrome'),
    win32: path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data'),
  }[platform()];
}

const hasModel = async (dir) => (await readdir(path.join(dir, MODEL_DIR)).catch(() => [])).length > 0;

/** Makes sure the test profile has the model files, without downloading if it can be helped. */
async function prepareModel() {
  if (process.env.FRESH) await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  if (await hasModel(PROFILE)) return 'already in the test profile';
  const own = ownProfileDir();
  if (own && (await hasModel(own))) {
    const from = path.join(own, MODEL_DIR);
    const to = path.join(PROFILE, MODEL_DIR);
    await rm(to, { recursive: true, force: true });
    const copy = {
      darwin: ['cp', ['-cR', from, to]], // -c: clone, no extra disk space on APFS
      linux: ['cp', ['-R', '--reflink=auto', from, to]],
      win32: ['robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS']],
    }[platform()];
    spawnSync(copy[0], copy[1], { stdio: 'ignore' });
    if (await hasModel(PROFILE)) return 'copied from your Chrome profile';
  }
  if (!process.env.ALLOW_DOWNLOAD) return null;
  return 'Chrome will download it now (a few GB)';
}

// ── A minimal DevTools-protocol client over Chrome's debugging pipe ─────────

function pipeClient(chrome) {
  const waiting = new Map();
  let nextId = 1;
  let buffer = '';
  chrome.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const pending = waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      chrome.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
}

// ── Tiny test runner ────────────────────────────────────────────────────────

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(err?.stack || err).split('\n').join('\n      ')}`);
  }
}
const quote = (text) => console.log(text.trim().split('\n').map((line) => `      │ ${line}`).join('\n'));

// ── Run ─────────────────────────────────────────────────────────────────────

const chromePath = findChrome();
if (!chromePath) {
  console.log('Google Chrome was not found. Set CHROME_PATH to its executable.');
  process.exit(1);
}
const model = await prepareModel();
if (!model) {
  console.log(
    "Chrome's built-in model is not on this computer yet, and this test does not download several GB unasked.\n" +
      'Run it again with ALLOW_DOWNLOAD=1, or turn the built-in AI on once in LinkPeek settings in your own Chrome.',
  );
  process.exit(1);
}

const server = await startServer();
await rm(path.join(PROFILE, 'DevToolsActivePort'), { force: true });
const chrome = spawn(chromePath, [
  ...(process.env.HEADED ? [] : ['--headless=new']),
  `--user-data-dir=${PROFILE}`, '--remote-debugging-pipe', '--remote-debugging-port=0',
  '--enable-unsafe-extension-debugging', // lets the pipe load an unpacked extension
  '--no-first-run', '--no-default-browser-check', '--window-size=1220,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const send = pipeClient(chrome);
let browser;
// Never leave the test's Chrome behind, also when the test itself is stopped.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    chrome.kill();
    process.exit(1);
  });
}

try {
  const { id: extensionId } = await send('Extensions.loadUnpacked', { path: EXT });
  const port = await waitFor(
    async () => (await readFile(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0],
    { what: "Chrome's debugging port" },
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];

  // A profile that has seen an older copy of the extension keeps its old
  // service worker. Make Chrome read the files again.
  await waitFor(async () => {
    const { targetInfos } = await send('Target.getTargets');
    const worker = targetInfos.find((target) => target.type === 'service_worker' && target.url.includes(extensionId));
    if (!worker) return false;
    const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    await send('Runtime.evaluate', { expression: 'setTimeout(() => chrome.runtime.reload(), 50)' }, sessionId);
    return true;
  }, { what: 'the extension to start' });
  await sleep(2500);

  const version = (await send('Browser.getVersion')).product;
  const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html`;
  console.log(`LinkPeek on-device · ${version} · model: ${model}\n`);

  const options = await context.newPage();
  // The extension may still be coming back from its reload: try until it is there.
  await waitFor(() => options.goto(optionsUrl).then(() => true), { timeout: 30_000, what: 'the settings page' });
  // No key, nothing chosen, nothing saved: the state of a fresh install.
  const configure = (patch, { clear = false } = {}) =>
    options.evaluate(async ([settings, wipe]) => {
      const { saveSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      const { clearSummaries } = await import(chrome.runtime.getURL('src/lib/summary-cache.js'));
      await saveSettings(settings);
      if (wipe) await clearSummaries();
    }, [patch, clear]);
  await configure({ apiKey: '', baseUrl: '', provider: 'auto', mode: '', reputation: true }, { clear: true });
  await options.reload();
  const builtinStatus = () => options.locator('#builtin-status');

  let modelWasOn = false;
  await step('settings: a fresh install on this computer starts on Keyless, and downloads nothing unasked', async () => {
    await waitFor(async () => (await builtinStatus().getAttribute('data-state')) !== 'checking', { timeout: 30_000, what: 'the state of the built-in AI' });
    assert.equal(await options.getAttribute('#modes .mode[data-mode="keyless"]', 'aria-checked'), 'true', 'Keyless is the starting choice');
    assert.equal(await options.isHidden('#api-key'), true);
    const state = await builtinStatus().getAttribute('data-state');
    assert.ok(['available', 'downloadable', 'downloading'].includes(state), `this computer cannot run the model (state: ${state}): ${await builtinStatus().textContent()}`);
    modelWasOn = state === 'available';
    // Nothing on this page is clicked. If the model is not on yet, the first
    // X+click below has to switch it on by itself.
    if (modelWasOn) assert.equal(await builtinStatus().textContent(), '✓ Ready on this computer. Hold X and click any link.');
    else assert.match(await builtinStatus().textContent(), /^One step left: Chrome downloads its AI model once/);
    console.log(`      model before the first peek: ${modelWasOn ? 'already on' : 'not on yet'}`);
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1180, height: 820 });
  // A key pressed in the instant a page finishes loading can be lost before it
  // reaches the new document (no person is that fast). Give the page a moment.
  const visit = async (url) => {
    await page.goto(url);
    await sleep(500);
  };
  await visit(`${server.origin}/`);
  const ext = await attach(page, extensionId);
  const peek = async (selector) => {
    await page.keyboard.down('x');
    await page.click(selector);
    await page.keyboard.up('x');
  };

  // The shape every Keyless summary has, the same as the default with a key:
  // a bold TL;DR sentence, then key points.
  const assertShape = (state) => {
    assert.match(state.html, /<strong><em class="lp-tldr">TL;DR:<\/em>/, 'opens with the TL;DR label');
    const points = (state.html.match(/<li>/g) || []).length;
    assert.ok(points >= 3 && points <= 8, `key points as a list (got ${points})`);
    assert.ok(!/<h[1-6]/.test(state.html), 'no headings');
    assert.ok(!/^(here is|here's|sure|okay)/i.test(state.text), 'no preamble');
  };

  await step('Keyless: the first X + click switches the model on if need be, and gives a summary in the promised shape', async () => {
    const started = Date.now();
    await peek('#article');
    const state = await ext.settled(1, process.env.ALLOW_DOWNLOAD ? 3_600_000 : SLOW);
    assert.equal(state.error, '', 'no "one step left", no trip to the settings');
    if (!modelWasOn) console.log('      the model was switched on by this click');
    assert.equal(state.title, 'How a sourdough starter actually works');
    assert.equal(state.credit, 'Author: Mara Lindqvist, October 3, 2026', 'author and date in the header, as with a key');
    assert.match(state.sub, /min read$/);
    assert.equal(state.engine, 'AI running on this device');
    assertShape(state);
    assert.ok(state.text.length > 150, 'a real summary, not a stub');
    assert.match(state.text, /starter/i, 'about the page that was linked');
    assert.match(state.text, /yeast|bacteria|feed/i, 'with facts from it');
    assert.ok(!/NAV_NOISE|COOKIE_NOISE|<\/?[a-z]+>/.test(state.text), 'no page chrome, no stray tags');
    assert.equal(server.requests.length, 0, 'no AI service was contacted');
    console.log(`      first peek, model possibly asleep: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    quote(state.text);
  });

  await step('the reputation meter is rated on this computer too, and an invented publisher is not given a good name', async () => {
    // "The Weekend Reader" does not exist. Whatever the small model says about
    // it, the bubble must not present it as a trusted source.
    const state = await waitFor(async () => {
      const now = await ext.bubble();
      return now?.reputation ? now : null;
    }, { timeout: SLOW, what: 'the on-device source rating' });
    console.log(`      invented publisher → ${state.reputation.label} · ${state.reputation.aria.split('Why: ')[1]?.split('. Decided')[0] || ''}`);
    assert.ok(!['High', 'Very high'].includes(state.reputation.label), `an invented source rated ${state.reputation.label}`);
    assert.match(state.reputation.aria, /Decided by Chrome’s small on-device AI/);
  });

  await step('source ratings by the real model: well-known sources land where they should', async () => {
    // Asked the way the bubble asks, through the extension's own channel.
    const rate = (source) =>
      ext.evaluate(`new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'linkpeek' });
        port.onMessage.addListener((message) => {
          if (message.type !== 'reputation') return;
          resolve(message.rating);
          port.disconnect();
        });
        port.postMessage({ type: 'reputation', page: ${JSON.stringify(source)} });
      })`);
    const cases = [
      [{ url: 'https://www.reuters.com/world/a', siteName: 'Reuters', title: 'An article' }, (level) => level >= 4],
      [{ url: 'https://www.nature.com/articles/a', siteName: 'Nature', title: 'An article' }, (level) => level >= 4],
      [{ url: 'https://www.infowars.com/posts/a', siteName: 'Infowars', title: 'An article' }, (level) => level >= 1 && level <= 2],
      [{ url: 'https://zorblat-daily-gazette.example/a', siteName: 'Zorblat Daily Gazette', byline: 'Quill Varnok', title: 'An article' }, (level) => level === 0],
    ];
    for (const [source, plausible] of cases) {
      const rating = await rate(source);
      console.log(`      ${source.siteName} → ${rating ? `${rating.level}: ${rating.reason}` : 'no rating'}`);
      assert.ok(rating && plausible(rating.level), `${source.siteName} was rated ${rating?.level}`);
    }
  });

  await step('a follow-up question is answered from the page', async () => {
    const started = Date.now();
    const { input } = await ext.bubble();
    await page.mouse.click(input.x, input.y);
    await page.keyboard.type('At what temperature should I keep it?');
    await page.keyboard.press('Enter');
    const state = await ext.settled(3, SLOW);
    assert.equal(state.error, '');
    const answer = state.text.split('At what temperature should I keep it?').pop();
    assert.match(answer, /24/, 'the page says about 24 °C');
    console.log(`      answer after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    quote(answer);
    await page.keyboard.press('Escape');
  });

  await step('peeking at the same page again is instant: the summary was saved', async () => {
    const started = Date.now();
    await peek('#article');
    const state = await ext.settled(1, SLOW);
    assert.match(state.notes.join(' '), /^Saved summary from /);
    assert.ok(Date.now() - started < 3000, 'no model involved');
    await page.keyboard.press('Escape');
  });

  await step('a second page, with the model awake, is quick', async () => {
    const started = Date.now();
    await peek('#spa'); // a page that only exists after JavaScript runs
    const state = await ext.settled(1, SLOW);
    assert.equal(state.error, '');
    assertShape(state);
    assert.match(state.text, /offline|2\.4|release/i, 'read through a background tab, then summarized on this computer');
    const seconds = (Date.now() - started) / 1000;
    console.log(`      a peek with the model awake: ${seconds.toFixed(1)} s`);
    assert.ok(seconds < 30, 'well under the cold start');
    await page.keyboard.press('Escape');
  });

  await step('a page far longer than the model can read is cut, and the bubble says so', async () => {
    await visit(`${server.origin}/long.html`);
    await page.evaluate((href) => {
      const link = Object.assign(document.createElement('a'), { id: 'self', href, textContent: 'The complete logbook' });
      document.body.prepend(link);
    }, `${server.origin}/long.html`);
    await peek('#self');
    const state = await ext.settled(1, SLOW);
    assert.equal(state.error, '');
    assert.match(state.notes.join(' '), /^Long page: Keyless read about the first [\d,]+ words\./);
    assertShape(state);
    assert.match(state.text, /lighthouse|Cape Verity/i, 'the beginning of the page was read');
    assert.ok(!/Ottoline/.test(state.text), 'the last section was not');
    console.log(`      ${state.notes[0]}`);
    quote(state.text.replace(state.notes[0], ''));
    await page.keyboard.press('Escape');
  });

  await step('Stop cancels the model mid-answer', async () => {
    await visit(`${server.origin}/long.html?again`);
    await page.evaluate((href) => {
      document.body.prepend(Object.assign(document.createElement('a'), { id: 'self', href, textContent: 'The logbook, again' }));
    }, `${server.origin}/long.html?stop`);
    await options.evaluate(async () => {
      const { clearSummaries } = await import(chrome.runtime.getURL('src/lib/summary-cache.js'));
      await clearSummaries();
    });
    await peek('#self');
    const partial = await waitFor(async () => {
      const state = await ext.bubble();
      return state?.busy && state.text.length > 30 && !state.status ? state : null;
    }, { timeout: SLOW, what: 'the answer to start' });
    assert.ok(partial.busy);
    // The bubble grows while the answer streams in, so the button moves:
    // aim at where it is now, until the click has landed.
    for (let tries = 0; tries < 6; tries++) {
      const now = await ext.bubble();
      if (!now.busy) break;
      await page.mouse.click(now.send.x, now.send.y);
      await sleep(120);
    }
    const state = await ext.settled(1, 10_000);
    assert.match(state.text, /Stopped\.$/);
    await page.keyboard.press('Escape');
  });

  await step('a PDF is declined with a way forward, not a wrong answer', async () => {
    await visit(`${server.origin}/`);
    await peek('#pdf');
    const state = await ext.settled(1, SLOW);
    assert.match(state.error, /^Keyless cannot read PDFs\. Switch to “Your key”/);
    assert.deepEqual(state.buttons, ['Open settings']);
    await page.keyboard.press('Escape');
  });

  await step('a page in a language Chrome does not list (Russian) still gets a summary in the same shape', async () => {
    await visit(`${server.origin}/`);
    await peek('#legacy');
    const state = await ext.settled(1, SLOW);
    assert.equal(state.error, '');
    assert.match(state.html, /<em class="lp-tldr">TL;DR:<\/em>/);
    quote(state.text);
    await page.keyboard.press('Escape');
  });

  await step('a saved key is left alone while Keyless is the choice', async () => {
    // The key points at the local stand-in for Claude, so a request would be seen.
    await configure({ apiKey: 'sk-ant-test-key', baseUrl: `${server.origin}/anthropic` });
    await visit(`${server.origin}/`);
    await peek('#notes');
    const state = await ext.settled(1, SLOW);
    assert.equal(state.error, '');
    assert.equal(state.engine, 'AI running on this device');
    assertShape(state);
    await page.keyboard.press('Escape');
  });

  await step('no AI service was contacted at any point', async () => {
    assert.equal(server.requests.length, 0);
    assert.equal(server.reputationRequests.length, 0);
  });
} finally {
  await browser?.close().catch(() => {});
  chrome.kill();
  await server.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
