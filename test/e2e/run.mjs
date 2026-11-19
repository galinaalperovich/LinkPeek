// End-to-end test: loads the real extension into Chromium and drives it the
// way a person would (hold X, click a link), against local fixture pages and
// mock Claude / OpenAI endpoints. No real API key, nothing leaves the machine.
//
//   npm run test:e2e              headless
//   HEADED=1 npm run test:e2e     watch it happen
//   SHOTS=1 npm run test:e2e      also refresh the screenshots in docs/
//   npm run store                 also refresh the Chrome Web Store images in store/
//   EXT_DIR=path npm run test:e2e test another copy, e.g. the unzipped store package

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURDOUGH_ANSWER, startServer } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = path.join(ROOT, 'docs');
const HEADED = Boolean(process.env.HEADED);
const STORE = Boolean(process.env.STORE); // also write the Chrome Web Store images into store/
const SHOTS = Boolean(process.env.SHOTS) || STORE;
// EXT_DIR tests another copy of the extension, e.g. the unzipped store package.
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : ROOT;
const STORE_DIR = path.join(ROOT, 'store');
// Screenshots show a believable site name instead of 127.0.0.1.
const DEMO_HOST = 'weekend.example';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 15_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(60);
  }
  throw new Error(`Timed out waiting for ${what}. Last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// The bubble lives in a closed shadow root that page scripts (and Playwright
// selectors) cannot enter. Tests look at it from the content script's own
// isolated world, through the DevTools protocol.
const BUBBLE_STATE = `(() => {
  const b = globalThis.__linkpeek?.bubble;
  if (!b) return null;
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const panel = b.panel.getBoundingClientRect();
  return {
    title: b.titleEl.textContent,
    href: b.titleEl.getAttribute('href'),
    sub: [b.hostEl.textContent, b.factsEl.textContent].filter(Boolean).join(' '),
    credit: b.creditEl.hidden ? '' : b.creditEl.textContent,
    reputation: b.repEl.hidden ? null : {
      label: b.repEl.textContent,
      bars: b.repEl.querySelectorAll('.lp-meter i.on').length,
      tone: b.repEl.className,
      aria: b.repEl.getAttribute('aria-label'),
      tip: b.tipEl.hidden ? '' : b.tipEl.innerText,
      tipBox: b.tipEl.hidden ? null : (({ x, y, width, height }) => ({ x, y, width, height }))(b.tipEl.getBoundingClientRect()),
      at: center(b.repEl),
    },
    text: b.body.innerText,
    html: b.body.innerHTML,
    busy: b.busy,
    turns: b.history.length,
    status: b.statusEl.hidden ? '' : b.statusText.textContent,
    error: b.body.querySelector('.lp-error-msg')?.textContent || '',
    buttons: [...b.body.querySelectorAll('.lp-btn')].map((el) => el.textContent),
    inputDisabled: b.input.disabled,
    input: center(b.input),
    send: center(b.sendBtn),
    again: b.body.querySelector('.lp-linkbtn') ? center(b.body.querySelector('.lp-linkbtn')) : null,
    close: center(b.head.querySelector('button[aria-label="Close"]')),
    head: { x: panel.x + 150, y: panel.y + 20 },
    panel: { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
    topLayer: b.host.matches(':popover-open'),
  };
})()`;

async function attach(page, extensionId) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const world = [...contexts.values()].find(
      (context) => context.auxData?.type === 'isolated' && String(context.origin).includes(extensionId),
    );
    if (!world) throw new Error('LinkPeek content script world not found');
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression, contextId: world.id, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };

  return {
    evaluate,
    bubble: () => evaluate(BUBBLE_STATE),
    /** Waits until a reply has fully arrived (or an error is shown). */
    settled: (turns = 1) =>
      waitFor(async () => {
        const state = await evaluate(BUBBLE_STATE);
        return state && !state.busy && (state.turns >= turns || state.error) ? state : null;
      }, { what: `bubble to settle with ${turns} turn(s)` }),
  };
}

// Saved summaries would make repeat peeks skip the model, so every peek starts
// from an empty cache unless a test is about the cache itself.
let clearCache = async () => {};

async function peek(page, selector, { keepCache = false } = {}) {
  if (!keepCache) await clearCache();
  await page.keyboard.down('x');
  await page.click(selector);
  await page.keyboard.up('x');
}

// ── Tiny test runner ───────────────────────────────────────────────────────

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err?.stack || err).split('\n').join('\n      ')}`);
  }
}

// ── Run ────────────────────────────────────────────────────────────────────

const server = await startServer();
const profile = await mkdtemp(path.join(tmpdir(), 'linkpeek-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', // the full browser: its headless mode can load extensions
  headless: !HEADED,
  viewport: { width: 1180, height: 820 },
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run',
    `--host-resolver-rules=MAP ${DEMO_HOST} 127.0.0.1`,
  ],
});

try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html`;
  // Settings are written the way the settings page writes them, from an
  // extension page (the key store is not reachable from anywhere else).
  let admin;
  const configure = ({ local = {}, sync = {} }) =>
    admin.evaluate(async (patch) => {
      const { saveSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      await saveSettings(patch);
    }, { ...local, ...sync });
  const anthropic = { apiKey: 'sk-ant-test-key', baseUrl: `${server.origin}/anthropic` };
  const openai = { apiKey: 'sk-test-openai-key', baseUrl: `${server.origin}/openai` };

  console.log(`LinkPeek e2e · extension ${extensionId} · fixtures at ${server.origin}\n`);

  await step('first run opens the settings page', async () => {
    await waitFor(() => context.pages().some((p) => p.url().startsWith(optionsUrl)), { what: 'settings tab' });
    for (const p of context.pages()) if (p.url().startsWith(optionsUrl)) await p.close();
  });

  admin = await context.newPage();
  await admin.goto(optionsUrl);
  const cache = (fn) =>
    admin.evaluate(async (name) => {
      const api = await import(chrome.runtime.getURL('src/lib/summary-cache.js'));
      return api[name]();
    }, fn);
  clearCache = () => cache('clearSummaries');
  await configure({ local: anthropic });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  await page.bringToFront();
  const tabs = context.pages().length; // the reader's tab plus the admin page
  const ext = await attach(page, extensionId);
  const home = page.url();
  let summary;

  await step('X + click summarizes the link in a bubble, without leaving the page', async () => {
    await peek(page, '#article');
    summary = await ext.settled();
    assert.equal(page.url(), home, 'the page must not navigate');
    assert.equal(summary.error, '');
    assert.equal(summary.title, 'How a sourdough starter actually works');
    assert.equal(summary.href, `${server.origin}/article.html`);
    assert.match(summary.sub, /^127\.0\.0\.1 · \d+ min read$/);
    assert.equal(summary.credit, 'Author: Mara Lindqvist, October 3, 2026', 'author and date in the header');
    assert.match(summary.text, /TL;DR: A sourdough starter is a stable culture/);
    assert.match(summary.html, /<strong>TL;DR:<\/strong>/);
    assert.equal((summary.html.match(/<li>/g) || []).length, 5, 'five bullet points');
    assert.ok(!summary.text.includes('**'), 'no raw Markdown left');
    assert.equal(summary.inputDisabled, false);
    assert.ok(summary.topLayer, 'bubble is in the top layer');
    assert.equal(context.pages().length, tabs, 'a readable page needs no extra tab');
  });

  await step('the bubble sits next to the link, inside the viewport', async () => {
    const link = await page.locator('#article').boundingBox();
    const { panel } = summary;
    assert.ok(panel.y >= link.y + link.height, 'below the link');
    assert.ok(panel.y - (link.y + link.height) < 40, 'close to the link');
    assert.ok(panel.x >= 0 && panel.x + panel.width <= 1180 && panel.y + panel.height <= 820, 'inside the viewport');
  });

  await step('the page is read cleanly and sent to Claude in the documented shape', async () => {
    assert.equal(server.requests.length, 1);
    const { headers, body } = server.requests[0];
    assert.equal(headers['x-api-key'], 'sk-ant-test-key');
    assert.equal(headers['anthropic-version'], '2026-10-21');
    assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.stream, true);
    assert.match(body.system, /<format>\nStart with a one-sentence TL;DR in bold\./);
    const [pageBlock, request] = body.messages[0].content;
    assert.deepEqual(pageBlock.cache_control, { type: 'ephemeral' });
    assert.match(request.text, /^Summarize this page/);
    const text = pageBlock.text;
    for (const expected of [
      `<url>${server.origin}/article.html</url>`,
      '<title>How a sourdough starter actually works</title>',
      '<site>The Weekend Reader</site>',
      '<author>Mara Lindqvist</author>',
      '<published>2026-10-03T08:00:00Z</published>',
      '<link_text>How a sourdough starter actually works</link_text>',
      '# How a sourdough starter actually works',
      '## The first ten days',
      '- Feed once a day at a 1:1:1 ratio',
      'ratio = 1 : 1 : 1   # starter : flour : water',
      'not dead. Keep feeding',
    ]) assert.ok(text.includes(expected), `page text should include: ${expected}`);
    for (const noise of ['NAV_NOISE', 'COOKIE_NOISE', 'ASIDE_NOISE', 'FOOTER_NOISE', 'SCRIPT_NOISE', 'HIDDEN_NOISE', '.promo']) {
      assert.ok(!text.includes(noise), `page text should not include ${noise}`);
    }
  });

  await step('the source gets a reputation meter, marked as an AI estimate', async () => {
    const { reputation } = await waitFor(async () => {
      const state = await ext.bubble();
      return state?.reputation ? state : null;
    }, { what: 'reputation meter' });
    assert.equal(reputation.label, 'High');
    assert.equal(reputation.bars, 4, 'four of five bars lit');
    assert.match(reputation.tone, /lp-rep-good/);
    assert.equal(reputation.tip, '', 'the explanation stays out of the way until hovered');
    assert.match(reputation.aria, /^Source reputation: High, 4 of 5\. A generally reliable source\. .*Decided by AI/);

    // It was rated from who published the page, not from what the page says.
    assert.equal(server.reputationRequests.length, 1);
    const { body } = server.reputationRequests[0];
    const source = body.messages[0].content[0].text;
    assert.ok(source.includes('<publisher>The Weekend Reader</publisher>'));
    assert.ok(source.includes('<author>Mara Lindqvist</author>'));
    assert.ok(!source.includes('small, stable ecosystem'), 'no page text in the rating request');
    assert.equal(server.requests.length, 1, 'the summary request is separate');

    // Hovering the meter says what "High" means, why, and that an AI decided it.
    await page.mouse.move(reputation.at.x, reputation.at.y);
    const hovered = (await ext.bubble()).reputation;
    for (const piece of [
      'Source reputation: High', '4 of 5', 'A generally reliable source.',
      'Why: Established food magazine with named authors.',
      'Decided by AI from what it knows about this publisher and author.', 'not a verified rating',
    ]) assert.ok(hovered.tip.includes(piece), `hover card should say: ${piece}\n${hovered.tip}`);
    const box = hovered.tipBox;
    assert.ok(box.y > reputation.at.y, 'the card opens under the meter');
    assert.ok(box.x >= 0 && box.x + box.width <= 1180 && box.y + box.height <= 820, 'inside the viewport');
    await page.mouse.move(40, 780);
    assert.equal((await ext.bubble()).reputation.tip, '', 'and goes away when the pointer leaves');
  });

  await step('asking a follow-up question answers in the bubble', async () => {
    const keysBefore = await page.evaluate(() => window.__pageKeys.length);
    const clicksBefore = await page.evaluate(() => window.__pageClicks);
    await page.mouse.click(summary.input.x, summary.input.y);
    await page.keyboard.type('How long until it is ready? xx');
    await page.keyboard.press('Enter');
    const state = await ext.settled(3);
    assert.equal(state.error, '');
    assert.match(state.text, /How long until it is ready\? xx/);
    assert.match(state.text, /About 7 to 10 days at room temperature/);
    assert.equal(page.url(), home);

    const { body } = server.requests.at(-1);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(body.messages[0], server.requests[0].body.messages[0], 'page prefix unchanged (cacheable)');
    assert.match(body.messages[1].content[0].text, /^\*\*TL;DR:\*\* A sourdough starter/);
    assert.equal(body.messages[2].content[0].text, 'How long until it is ready? xx');

    assert.equal(await page.evaluate(() => window.__pageKeys.length), keysBefore, 'typing in the bubble must not reach page shortcuts');
    assert.equal(await page.evaluate(() => window.__pageClicks), clicksBefore, 'clicks in the bubble must not reach page handlers');
    assert.equal(await ext.evaluate('Boolean(globalThis.__linkpeek.bubble)'), true, 'typing x in the question must not re-trigger');
  });

  await step('a second question keeps the whole conversation', async () => {
    const state = await ext.bubble();
    await page.mouse.click(state.input.x, state.input.y);
    await page.keyboard.type('And storage?');
    await page.mouse.click(state.send.x, state.send.y);
    await ext.settled(5);
    assert.deepEqual(server.requests.at(-1).body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.equal(server.requests.at(-1).body.messages[3].content[0].text, SOURDOUGH_ANSWER);
  });

  await step('the bubble can be dragged by its header', async () => {
    const before = await ext.bubble();
    await page.mouse.move(before.head.x, before.head.y);
    await page.mouse.down();
    await page.mouse.move(before.head.x + 120, before.head.y - 60, { steps: 6 });
    await page.mouse.up();
    const after = await ext.bubble();
    assert.ok(Math.abs(after.panel.x - before.panel.x - 120) < 3, `moved right: ${before.panel.x} → ${after.panel.x}`);
    assert.ok(Math.abs(after.panel.y - before.panel.y + 60) < 3, `moved up: ${before.panel.y} → ${after.panel.y}`);
  });

  if (SHOTS) {
    await step('screenshots for the README' + (STORE ? ' and the store listing' : ''), async () => {
      await mkdir(DOCS, { recursive: true });
      if (STORE) await mkdir(path.join(STORE_DIR, 'screenshots'), { recursive: true });
      const storeShot = (target, name) =>
        STORE && target.screenshot({ path: path.join(STORE_DIR, 'screenshots', name), type: 'jpeg', quality: 93 });

      // A separate, tidy page, so the bubble on the test page is left alone.
      const demo = await context.newPage();
      await demo.setViewportSize({ width: 1280, height: 800 }); // the store's screenshot size
      await demo.goto(`http://${DEMO_HOST}:${new URL(server.origin).port}/demo.html`);
      await demo.bringToFront();
      const demoExt = await attach(demo, extensionId);
      const rest = async () => {
        await demo.mouse.move(60, 770);
        await sleep(300);
      };
      const clip = { x: 200, y: 0, width: 880, height: 800 };

      for (const scheme of ['light', 'dark']) {
        await demo.emulateMedia({ colorScheme: scheme });
        await peek(demo, '#article');
        let state = await demoExt.settled();
        await waitFor(async () => (await demoExt.bubble())?.reputation, { what: 'reputation meter' });
        await rest();
        if (scheme === 'light') await storeShot(demo, '1-summary.jpg');

        await demo.mouse.click(state.input.x, state.input.y);
        await demo.keyboard.type('How long until it is ready?');
        await demo.keyboard.press('Enter');
        await demoExt.settled(3);
        await rest();
        await demo.screenshot({ path: path.join(DOCS, `bubble-${scheme}.png`), clip });
        await storeShot(demo, scheme === 'light' ? '2-ask.jpg' : '4-dark.jpg');

        if (scheme === 'light') {
          state = await demoExt.bubble();
          await demo.mouse.move(state.reputation.at.x, state.reputation.at.y);
          await sleep(300);
          await demo.screenshot({
            path: path.join(DOCS, 'reputation.png'),
            clip: { x: state.panel.x - 12, y: state.panel.y - 12, width: state.panel.width + 24, height: 272 },
          });
          await storeShot(demo, '3-reputation.jpg');
          await rest();
        }
        await demoExt.evaluate('globalThis.__linkpeek.bubble.close()');
      }
      await demo.close();

      if (STORE) {
        // Promo tiles, rendered from store/promo.html at the sizes the store asks for.
        const promo = await context.newPage();
        for (const [name, width, height] of [['promo-small.jpg', 440, 280], ['promo-marquee.jpg', 1400, 560]]) {
          await promo.setViewportSize({ width, height });
          await promo.goto(pathToFileURL(path.join(STORE_DIR, 'promo.html')).href);
          await sleep(250);
          await promo.screenshot({ path: path.join(STORE_DIR, name), type: 'jpeg', quality: 95 });
        }
        await promo.close();
      }
      await page.bringToFront();
    });
  }

  await step('Escape closes the bubble and removes it from the page', async () => {
    await page.mouse.click(30, 30); // focus back on the page
    await page.keyboard.press('Escape');
    assert.equal(await ext.bubble(), null);
    assert.equal(await page.evaluate(() => document.querySelector('linkpeek-bubble')), null);
  });

  await step('a normal click, a same-page anchor and a held key in a text box behave as usual', async () => {
    await peek(page, '#hash'); // X + click on a same-page anchor: not ours
    assert.equal(await ext.bubble(), null);
    assert.equal(page.url(), `${home}#top`);

    await page.click('#search');
    await page.keyboard.type('xylophone');
    assert.equal(await page.inputValue('#search'), 'xylophone', 'X still types');

    await Promise.all([page.waitForURL('**/article.html'), page.click('#article')]);
    await page.goBack();
    await page.waitForURL(`${home}#top`);
  });

  await step('a JavaScript-rendered page is read through a background tab, which is then closed', async () => {
    const requestsBefore = server.requests.length;
    const opened = [];
    const onPage = (p) => opened.push(p);
    context.on('page', onPage);
    await peek(page, '#spa');
    const sawTabStatus = await waitFor(async () => {
      const state = await ext.bubble();
      return state?.status.includes('background tab') || (state && !state.busy);
    }, { what: 'background tab status' });
    assert.ok(sawTabStatus);
    const state = await ext.settled();
    context.off('page', onPage);

    assert.equal(state.error, '');
    assert.equal(state.title, 'Orbit 4.0 release notes');
    assert.equal(state.credit, '', 'no author or date on the page: no credit line');
    assert.equal(state.reputation, null, 'nothing to rate on an unnamed local page');
    assert.equal(server.requests.length, requestsBefore + 1);
    const text = server.requests.at(-1).body.messages[0].content[0].text;
    assert.ok(text.includes('RENDERED_BY_JS Orbit 4.0 is the largest release'), 'text created by JavaScript was captured');
    assert.ok(!text.includes('enable JavaScript'), 'the noscript fallback was not');

    assert.equal(opened.length, 1, 'exactly one helper tab was opened');
    await waitFor(() => context.pages().length === tabs, { what: 'helper tab to close' });
    assert.equal(page.url(), `${home}#top`);
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'the reader’s tab stayed in front');
  });

  await step('a PDF link is sent to the model as a document', async () => {
    await peek(page, '#pdf');
    const state = await ext.settled();
    assert.equal(state.error, '');
    assert.match(state.sub, /PDF 1 KB$/);
    const [doc, meta] = server.requests.at(-1).body.messages[0].content;
    assert.equal(doc.type, 'document');
    assert.equal(doc.source.media_type, 'application/pdf');
    assert.ok(Buffer.from(doc.source.data, 'base64').toString('latin1').startsWith('%PDF-1.4'));
    assert.match(meta.text, /paper\.pdf/);

    await page.mouse.click(state.input.x, state.input.y);
    await page.keyboard.type('What is it about?');
    await page.keyboard.press('Enter');
    await ext.settled(3);
    assert.equal(server.requests.at(-1).body.messages[0].content[0].type, 'document', 'follow-ups re-attach the PDF');
  });

  await step('a windows-1251 page arrives as readable text', async () => {
    await peek(page, '#legacy');
    const state = await ext.settled();
    assert.equal(state.error, '');
    assert.equal(state.title, 'Старая страница');
    const text = server.requests.at(-1).body.messages[0].content[0].text;
    assert.ok(text.includes('# Привет, мир'));
    assert.ok(text.includes('Эта страница сохранена в кодировке windows-1251'));
  });

  await step('plain-text links work too', async () => {
    await peek(page, '#notes');
    const state = await ext.settled();
    assert.equal(state.error, '');
    assert.ok(server.requests.at(-1).body.messages[0].content[0].text.includes('PLAIN_TEXT_NOTES'));
  });

  await step('a dead link says so and never calls the model', async () => {
    const requestsBefore = server.requests.length;
    await peek(page, '#missing');
    const state = await ext.settled();
    assert.match(state.error, /does not exist \(HTTP 404\)/);
    assert.deepEqual(state.buttons, [], 'nothing to retry');
    assert.equal(server.requests.length, requestsBefore);
    assert.equal(context.pages().length, tabs);
  });

  await step('"Peek at this link" (context menu) opens the bubble as well', async () => {
    const ratingsBefore = server.reputationRequests.length;
    await worker.evaluate(async ({ origin, url }) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      await chrome.tabs.sendMessage(tab.id, { type: 'linkpeek:open', url }, { frameId: 0 });
    }, { origin: server.origin, url: `${server.origin}/article.html` });
    const state = await ext.settled();
    assert.match(state.text, /TL;DR: A sourdough starter/);
    // Same source as before: the meter comes back without asking the model again.
    await waitFor(async () => (await ext.bubble())?.reputation?.label === 'High', { what: 'cached reputation' });
    assert.equal(server.reputationRequests.length, ratingsBefore, 'one rating request per source');
  });

  await step('the reputation meter can be switched off', async () => {
    const before = server.reputationRequests.length;
    await configure({ sync: { reputation: false } });
    await peek(page, '#article');
    await ext.settled();
    await sleep(400);
    assert.equal((await ext.bubble()).reputation, null);
    assert.equal(server.reputationRequests.length, before);
    await configure({ sync: { reputation: true } });
  });

  await step('an unchanged page is served from the saved summary, with no model call', async () => {
    await peek(page, '#article'); // starts from an empty cache
    await ext.settled();
    assert.equal(await cache('countSummaries'), 1, 'the finished summary was saved');
    const before = server.requests.length;

    await peek(page, '#article', { keepCache: true });
    const saved = await ext.settled();
    assert.equal(server.requests.length, before, 'same content: the model is not asked again');
    assert.match(saved.text, /TL;DR: A sourdough starter is a stable culture/);
    assert.match(saved.text, /Saved summary from just now\. The page has not changed since\. Summarize again$/);
    assert.equal(saved.turns, 1, 'a saved summary can be followed up like any other');

    // "Summarize again" goes back to the model and replaces the saved copy.
    await page.mouse.click(saved.again.x, saved.again.y);
    const fresh = await waitFor(async () => {
      const state = await ext.bubble();
      return state && !state.busy && server.requests.length === before + 1 ? state : null;
    }, { what: 'a fresh summary' });
    assert.ok(!fresh.text.includes('Saved summary'), 'a fresh summary carries no cache note');
    assert.equal(await cache('countSummaries'), 1);
  });

  await step('changed content, format or model makes a new summary', async () => {
    await clearCache();
    await peek(page, '#changing', { keepCache: true });
    await ext.settled();
    const before = server.requests.length;
    await peek(page, '#changing', { keepCache: true }); // same address, new content
    const state = await ext.settled();
    assert.equal(server.requests.length, before + 1, 'the content hash differs, so the model is asked');
    assert.ok(!state.text.includes('Saved summary'));

    await peek(page, '#article', { keepCache: true });
    await ext.settled();
    const afterFirst = server.requests.length;
    await configure({ sync: { format: 'One line only.' } });
    await peek(page, '#article', { keepCache: true });
    await ext.settled();
    assert.equal(server.requests.length, afterFirst + 1, 'a new format is a new summary');
    await configure({ sync: { format: 'placeholder' } });
  });

  await step('stopping mid-answer keeps what has arrived', async () => {
    server.state.chunkDelay = 80;
    await peek(page, '#article');
    const partial = await waitFor(async () => {
      const state = await ext.bubble();
      return state?.busy && state.text.includes('TL;DR') ? state : null;
    }, { what: 'streaming to start' });
    await page.mouse.click(partial.send.x, partial.send.y); // the send button is a stop button while busy
    const state = await ext.settled();
    server.state.chunkDelay = 6;
    assert.match(state.text, /Stopped\.$/);
    assert.ok(state.text.length < 500, 'the reply was cut short');
    assert.equal(state.turns, 1, 'the partial summary is kept for follow-ups');
    assert.equal(await cache('countSummaries'), 0, 'a summary that was cut short is not saved');
  });

  await step('the model and format from settings are used', async () => {
    await configure({ sync: { models: { anthropic: 'claude-haiku-5-5', openai: '' }, format: 'One sentence. In French.' } });
    await peek(page, '#article');
    await ext.settled();
    const { headers, body } = server.requests.at(-1);
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.match(body.system, /<format>\nOne sentence\. In French\.\n<\/format>/);
    assert.ok(!('fallbacks' in body) && !headers['anthropic-beta'], 'Haiku has no server-side fallback');
    await configure({ sync: { models: { anthropic: '', openai: '' } } });
  });

  await step('an OpenAI key switches to the OpenAI API', async () => {
    await configure({ local: openai });
    await peek(page, '#article');
    const state = await ext.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /TL;DR: A sourdough starter/);
    const { api, headers, body } = server.requests.at(-1);
    assert.equal(api, 'openai');
    assert.equal(headers.authorization, 'Bearer sk-test-openai-key');
    assert.equal(body.model, 'gpt-6.2-sol');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[1].content, /<title>How a sourdough starter actually works<\/title>/);
    assert.ok(!headers['x-api-key']);

    await page.mouse.click(state.input.x, state.input.y);
    await page.keyboard.type('How long?');
    await page.keyboard.press('Enter');
    const answered = await ext.settled(3);
    assert.match(answered.text, /About 7 to 10 days/);
    assert.deepEqual(server.requests.at(-1).body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  });

  await step('the shortcut key can be changed', async () => {
    await configure({ sync: { trigger: { kind: 'key', code: 'KeyS', label: 'S' } } });
    await page.keyboard.press('Escape');
    await waitFor(async () => (await ext.bubble()) === null, { what: 'bubble to close' });
    await sleep(150); // storage change reaches the content script
    await page.keyboard.down('s');
    await page.click('#notes');
    await page.keyboard.up('s');
    assert.ok(await ext.settled(), 'S + click works');
    await page.keyboard.press('Escape');
    await configure({ sync: { trigger: { kind: 'key', code: 'KeyX', label: 'X' } } });
    await sleep(150);
  });

  await step('without an API key the bubble points to settings', async () => {
    await configure({ local: { apiKey: '' } });
    await peek(page, '#article');
    const state = await ext.settled();
    assert.match(state.error, /Add your Claude or OpenAI API key/);
    assert.deepEqual(state.buttons, ['Open settings']);
    await page.keyboard.press('Escape');
  });

  await step('the API key cannot be read from the content script', async () => {
    await configure({ local: anthropic });
    // Everything a content script (or a page that compromised one) can reach.
    const reachable = await ext.evaluate(`Promise.all([
      chrome.storage.local.get(null), chrome.storage.sync.get(null), indexedDB.databases(),
    ]).then((all) => JSON.stringify(all))`);
    assert.ok(!reachable.includes('sk-ant-test-key'), `the key is reachable from the page side: ${reachable}`);
    assert.ok(!reachable.includes('127.0.0.1'), 'so is the base URL');
    assert.ok(reachable.includes('"trigger"') || reachable.includes('"format"'), 'preferences are readable, as intended');
  });

  await step('settings page: key check, explicit Save for the format, visible confirmations', async () => {
    await configure({ local: anthropic, sync: { format: 'placeholder' } });
    const options = await context.newPage();
    await options.goto(optionsUrl);
    const stored = () => worker.evaluate(() => chrome.storage.sync.get(null));

    // API key: detected, verified, masked.
    await options.waitForSelector('#key-status.ok');
    assert.equal(await options.textContent('#key-status'), '✓ Claude key works');
    assert.equal(await options.inputValue('#api-key'), 'sk-ant-test-key');
    assert.equal(await options.getAttribute('#api-key', 'type'), 'password');
    const models = await options.$$eval('#model option', (els) => els.map((el) => el.textContent));
    assert.deepEqual(models, [
      'Claude Opus 5.5 · best quality (default)', 'Claude Sonnet 5.5 · faster', 'Claude Haiku 5.5 · fastest, cheapest',
      'Claude Experimental', 'Custom model ID…',
    ]);

    // Summary format: nothing is applied until Save is pressed, and the page says so.
    assert.equal(await options.isDisabled('#save-format'), true, 'nothing to save yet');
    await options.fill('#format', 'Two sentences. In French.');
    assert.equal(await options.isDisabled('#save-format'), false);
    assert.equal(await options.textContent('#format-state'), 'Unsaved changes');
    await sleep(900);
    assert.equal((await stored()).format, 'placeholder', 'typing alone does not apply the format');
    await options.click('#save-format');
    await options.waitForSelector('#format-state.ok');
    assert.match(await options.textContent('#format-state'), /^✓ Saved/);
    assert.equal(await options.isDisabled('#save-format'), true);
    assert.equal((await stored()).format, 'Two sentences. In French.');

    // A preset is applied immediately, with the same confirmation.
    await options.click('#presets .chip:has-text("Brief")');
    await options.waitForSelector('#format-state.ok');
    await waitFor(async () => /^Summarize in 2 or 3 plain sentences/.test((await stored()).format), { what: 'preset to be stored' });
    assert.equal(await options.getAttribute('#presets .chip:has-text("Brief")', 'aria-pressed'), 'true');

    // Model: saved on change, confirmed in the corner of its card.
    await options.selectOption('#model', 'claude-sonnet-5-5');
    await options.waitForSelector('#saved-key.show');
    assert.equal(await options.textContent('#saved-key'), '✓ Saved');
    assert.equal((await stored()).models.anthropic, 'claude-sonnet-5-5');

    // Shortcut: "Change key", then press the key.
    assert.equal(await options.isDisabled('#reset-trigger'), true, 'already the default');
    await options.click('#change-trigger');
    assert.equal(await options.textContent('#trigger-key'), 'Press a key…');
    assert.equal(await options.textContent('#change-trigger'), 'Cancel');
    await options.keyboard.press('Escape');
    assert.equal(await options.textContent('#trigger-key'), 'X', 'Esc cancels');
    await options.click('#change-trigger');
    await options.keyboard.press('KeyG');
    assert.equal(await options.textContent('#trigger-key'), 'G');
    assert.equal(await options.textContent('#hint-key'), 'G');
    await options.waitForSelector('#saved-shortcut.show');
    assert.equal((await stored()).trigger.code, 'KeyG');
    await options.click('#reset-trigger');
    assert.equal(await options.textContent('#trigger-key'), 'X');
    await waitFor(async () => (await stored()).trigger.code === 'KeyX', { what: 'shortcut reset to be stored' });

    // A rejected key is reported; an OpenAI key flips the provider and model list.
    await options.fill('#api-key', 'sk-ant-bad');
    await options.waitForSelector('#key-status.bad');
    assert.match(await options.textContent('#key-status'), /rejected the API key/);
    await options.click('summary');
    assert.equal(await options.isChecked('#reputation'), true, 'reputation meter is on by default');
    await options.uncheck('#reputation');
    await options.waitForSelector('#saved-advanced.show');
    assert.equal((await stored()).reputation, false);
    await options.check('#reputation');
    await waitFor(async () => (await stored()).reputation === true, { what: 'reputation setting to be stored' });
    assert.match(await options.textContent('#cache-count'), /^Saved summaries: \d+$/);
    if (!(await options.isDisabled('#clear-cache'))) {
      await options.click('#clear-cache');
      await waitFor(async () => (await options.textContent('#cache-count')) === 'Saved summaries: 0', { what: 'cache to clear' });
      assert.equal(await cache('countSummaries'), 0);
    }
    assert.equal(await options.isDisabled('#clear-cache'), true, 'nothing left to clear');
    await options.fill('#base-url', `${server.origin}/openai`);
    await options.waitForSelector('#saved-advanced.show');
    await options.fill('#api-key', 'sk-test-openai-key');
    await options.waitForSelector('#key-status.ok');
    assert.equal(await options.textContent('#key-status'), '✓ OpenAI key works');
    const openaiModels = await options.$$eval('#model option', (els) => els.map((el) => el.textContent));
    assert.equal(openaiModels[0], 'GPT-6.2 Sol · everyday default (default)');
    assert.ok(!openaiModels.some((label) => label.includes('embedding')), 'non-chat models are hidden');

    await options.click('#presets .chip:has-text("Key points")');
    await options.waitForSelector('#format-state.ok');
    if (SHOTS) {
      await mkdir(DOCS, { recursive: true });
      // Still the mock endpoint: an example key must never be sent to a real API.
      await options.fill('#base-url', `${server.origin}/anthropic`);
      await options.fill('#api-key', 'sk-ant-api03-EXAMPLE-KEY-NOT-REAL');
      await options.waitForSelector('#key-status.ok');
      await options.selectOption('#model', '');
      await options.waitForSelector('#saved-key.show');
      await options.setViewportSize({ width: 660, height: 960 });
      // Shown mid-edit, so the Save button and its hint are visible.
      await options.fill('#format', (await options.inputValue('#format')).replace('150 words', '120 words'));
      await options.evaluate(() => {
        document.querySelector('details').open = false;
        document.activeElement?.blur();
        window.scrollTo(0, 0);
      });
      await sleep(2600); // let the "Saved" notes fade
      await options.screenshot({ path: path.join(DOCS, 'settings.png'), fullPage: true });
      if (STORE) {
        await options.setViewportSize({ width: 1280, height: 800 });
        await options.evaluate(() => window.scrollTo(0, 0));
        await sleep(200);
        await options.screenshot({ path: path.join(STORE_DIR, 'screenshots', '5-settings.jpg'), type: 'jpeg', quality: 93 });
      }
      await options.click('#presets .chip:has-text("Key points")');
      await options.waitForSelector('#format-state.ok');
    }
    await options.close();
  });

  await step('toolbar popup shows the same settings, compact', async () => {
    const popup = await context.newPage();
    await popup.goto(`${optionsUrl}?popup=1`);
    assert.equal(await popup.evaluate(() => document.documentElement.classList.contains('popup')), true);
    assert.equal(await popup.evaluate(() => getComputedStyle(document.body).width), '400px');
    await popup.close();
  });

  await step('works on a local file:// page too', async () => {
    const file = path.join(profile, 'local-notes.html');
    await writeFile(file, `<!doctype html><meta charset="utf-8"><title>Local notes</title>
      <p>My notes, with <a id="web" href="${server.origin}/article.html">a link to the web</a>.</p>`);
    const local = await context.newPage();
    await local.goto(pathToFileURL(file).href);
    await local.bringToFront();
    const localExt = await attach(local, extensionId);
    await peek(local, '#web');
    const state = await localExt.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /TL;DR: A sourdough starter/);
    assert.ok(local.url().startsWith('file://'), 'still on the local file');
    await local.close();
    await page.bringToFront();
  });

  await step('no helper tabs are left behind', async () => {
    assert.equal(context.pages().length, tabs);
  });
} finally {
  await context.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
