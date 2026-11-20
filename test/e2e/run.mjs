// End-to-end test: loads the real extension into Chromium and drives it the
// way a person would (hold X, click a link), against local fixture pages and
// mock Claude / OpenAI endpoints. No real API key, nothing leaves the machine.
// Chrome's built-in AI is played by a stand-in (see FAKE_MODEL): the browser
// used here ships without the model. `npm run test:ondevice` uses the real one.
//
//   npm run test:e2e              headless
//   HEADED=1 npm run test:e2e     watch it happen
//   SHOTS=1 npm run test:e2e      also refresh the screenshots in docs/
//   npm run store                 also refresh the Chrome Web Store images in store/
//   EXT_DIR=path npm run test:e2e test another copy, e.g. the unzipped store package

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ICON_COLOR, SOURDOUGH_ANSWER, startServer } from './server.mjs';
import { attach, sleep, waitFor } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = path.join(ROOT, 'docs');
const HEADED = Boolean(process.env.HEADED);
const STORE = Boolean(process.env.STORE); // also write the Chrome Web Store images into store/
const SHOTS = Boolean(process.env.SHOTS) || STORE;
// EXT_DIR tests another copy of the extension, e.g. the unzipped store package.
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : ROOT;
const STORE_DIR = path.join(ROOT, 'store');
// Screenshots show a believable site name instead of 127.0.0.1.
const DEMO_HOST = 'bytereview.example';

// A stand-in for Chrome's Prompt API (window.LanguageModel), with the shape
// and the behaviour measured on the real one in Chrome 158: availability
// states, a download that needs a click and reports progress, sessions with a
// context window, streamed replies, cancellation. Its "summary" is wrapped in
// a tag, as the real small model sometimes does. Everything it is asked is
// kept in `target.__fakeModel` for the tests to read.
const FAKE_MODEL = (target, config) => {
  const log = (target.__fakeModel = {
    state: 'available', window: 9216, hang: false, created: 0, prompts: [], ratings: [], active: 0, aborted: 0, ...config,
  });
  const count = (input) =>
    Math.ceil((typeof input === 'string' ? input : input.map((message) => message.content).join(' ')).length / 4);
  const cancelled = () => new DOMException('The request was cancelled.', 'AbortError');
  class Session {
    constructor(options) {
      this.options = options;
      this.contextUsage = count(options.initialPrompts?.[0]?.content || '');
    }
    get contextWindow() {
      return log.window;
    }
    async measureContextUsage(input) {
      return count(input);
    }
    async clone() {
      return new Session(this.options);
    }
    destroy() {}
    promptStreaming(input, { signal } = {}) {
      const system = this.options.initialPrompts?.[0]?.content || '';
      if (system.startsWith('You rate how far a reader can generally trust')) {
        // The source rating. One publisher it "knows"; for anything else it
        // does what the real small model does: a guess that admits it.
        log.ratings.push({ input, duringAnswer: log.active > 0 });
        const known = input[0].content.includes('<publisher>The Weekend Reader</publisher>');
        const answer = known
          ? '{"level": 4, "reason": "An established food magazine with editorial standards"}'
          : '{"level": 3, "reason": "Unknown outlet, but the author appears credible, so moderate trust"}';
        return (async function* rating() {
          yield answer.slice(0, 20);
          yield answer.slice(20);
        })();
      }
      log.prompts.push({ system, languages: this.options.expectedOutputs?.[0]?.languages, input });
      const question = input.length > 1 ? input[input.length - 1].content : '';
      const title = /<title>(.*?)<\/title>/.exec(input[0].content)?.[1] || 'the page';
      const reply = question
        ? `On this device: ${question}`
        : `<summary>\n**TL;DR:** ${title}, summarized on this device.\n\n- First point\n- Second point\n</summary>`;
      const pieces = reply.match(/[\s\S]{1,9}/g);
      return (async function* stream() {
        log.active++;
        try {
          yield* answer();
        } finally {
          log.active--;
        }
      })();
      async function* answer() {
        for (const [index, piece] of pieces.entries()) {
          if (signal?.aborted) throw cancelled();
          if (log.hang && index === 3) {
            // Goes quiet mid-answer until the reader presses Stop.
            await new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                log.aborted++;
                reject(cancelled());
              });
            });
          }
          yield piece;
        }
      }
    }
  }
  target.LanguageModel = {
    availability: async () => log.state,
    async create(options = {}) {
      if (log.state !== 'available') {
        if (!target.navigator.userActivation?.isActive) throw new DOMException('Requires a user gesture.', 'NotAllowedError');
        const monitor = new EventTarget();
        options.monitor?.(monitor);
        log.state = 'downloading';
        for (const loaded of [0, 0.42, 1]) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded, total: 1 }));
        }
        log.state = 'available';
      }
      log.created++;
      return new Session(options);
    },
  };
};

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
    '--host-resolver-rules=MAP *.example 127.0.0.1', // made-up site names for the fixtures
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
  // The key points at the local stand-in, so that is who the footer names.
  // (The real names, "Anthropic" and "OpenAI", are covered by the unit tests.)
  const viaMock = `AI provided by ${new URL(server.origin).host}`;
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
    assert.match(summary.html, /<strong><em class="lp-tldr">TL;DR:<\/em><\/strong>/, 'bold, and the label in italic');
    assert.equal(summary.fontSize, '12.5px');
    assert.equal((summary.html.match(/<li>/g) || []).length, 5, 'five bullet points');
    assert.ok(!summary.text.includes('**'), 'no raw Markdown left');
    assert.equal(summary.inputDisabled, false);
    assert.equal(summary.engine, viaMock, 'the footer names who made the answer');
    assert.equal(summary.footSize, '9px', 'in the smallest text of the bubble');
    assert.ok(summary.topLayer, 'bubble is in the top layer');
    assert.equal(context.pages().length, tabs, 'a readable page needs no extra tab');
  });

  await step("the bubble shows the site's own icon", async () => {
    const { icon } = await waitFor(async () => {
      const state = await ext.bubble();
      return state?.icon ? state : null;
    }, { what: 'site icon' });
    assert.deepEqual(icon, [...ICON_COLOR, 255], 'the pixels of the icon the page declares (a relative link, resolved)');
    assert.equal(server.state.iconRequests, 1);
    assert.equal(server.state.faviconRequests, 0, 'the declared icon was found, so /favicon.ico is not tried');
  });

  await step('hovering the title shows it in full, with the address', async () => {
    await page.mouse.move(summary.titleAt.x, summary.titleAt.y);
    const card = (await ext.bubble()).tip;
    assert.ok(card.includes('How a sourdough starter actually works'), card);
    assert.ok(card.includes(`${server.origin}/article.html`), 'and where it leads');
    assert.equal(await ext.evaluate('globalThis.__linkpeek.bubble.titleEl.getAttribute("title")'), null, 'no second, browser-made tooltip');
    await page.mouse.move(40, 780);
    assert.equal((await ext.bubble()).tip, '');
  });

  await step('the clicked link is marked while its bubble is open', async () => {
    const look = (selector) => page.$eval(selector, (el) => ({
      outline: el.style.outline,
      background: el.style.backgroundColor,
      priority: el.style.getPropertyPriority('outline'),
      attribute: el.getAttribute('style'),
    }));
    const marked = await look('#article');
    assert.match(marked.outline, /rgb\(245, 165, 36\)/, 'an amber ring around the link');
    assert.match(marked.background, /rgba\(245, 165, 36/, 'and a highlighter tint');
    assert.equal(marked.priority, 'important', 'the page\'s own styles cannot hide it');
    assert.equal((await look('#spa')).attribute, null, 'other links are untouched');
    const box = await page.locator('#article').boundingBox();
    assert.ok(Math.abs(box.y - (await page.locator('#article').evaluate((el) => el.getBoundingClientRect().y))) < 1, 'no layout shift');
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
      // The stand-in for the API lives at a local address, and that address is
      // what the bubble's footer would name. A reader with a Claude key sees
      // the company's name there, so that is what the pictures show.
      const settle = demoExt.settled;
      demoExt.settled = async (...args) => {
        const state = await settle(...args);
        await demoExt.evaluate(`(() => {
          const el = globalThis.__linkpeek?.bubble?.engineEl;
          if (el && !el.hidden) el.textContent = 'AI provided by Anthropic';
        })()`);
        return state;
      };
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
        await demo.screenshot({ path: path.join(DOCS, `summary-${scheme}.png`), clip }); // used by the banner
        if (scheme === 'light') await storeShot(demo, '1-summary.jpg');

        await demo.mouse.click(state.input.x, state.input.y);
        await demo.keyboard.type('What if I lose my phone?');
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
      // One picture per design, then all five side by side.
      await mkdir(path.join(DOCS, 'themes'), { recursive: true });
      const designs = [['light', 'Light'], ['dark', 'Dark'], ['vision', 'Color-blind safe'], ['paper', 'Paper'], ['midnight', 'Midnight']];
      for (const [name] of designs) {
        const dark = name === 'dark' || name === 'midnight';
        await demo.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
        await configure({ sync: { theme: name } });
        await peek(demo, '#article');
        await demoExt.settled();
        const state = await waitFor(async () => {
          const s = await demoExt.bubble();
          return s?.reputation && s.icon && s.theme.endsWith(name) ? s : null;
        }, { what: `${name} design ready` });
        await rest();
        await demo.screenshot({
          path: path.join(DOCS, 'themes', `${name}.png`),
          clip: { x: state.panel.x - 34, y: state.panel.y - 62, width: state.panel.width + 68, height: state.panel.height + 110 },
        });
        await demoExt.evaluate('globalThis.__linkpeek.bubble.close()');
      }
      await configure({ sync: { theme: 'auto' } });
      await demo.emulateMedia({ colorScheme: 'light' });
      await demo.close();

      // The pictures are embedded as data: a blank page may not load local files.
      const figures = [];
      for (const [name, label] of designs) {
        const data = (await readFile(path.join(DOCS, 'themes', `${name}.png`))).toString('base64');
        figures.push(`<figure style="margin:0;flex:1;text-align:center"><img src="data:image/png;base64,${data}" style="width:100%;border-radius:12px;display:block;margin-bottom:12px">${label}</figure>`);
      }
      const gallery = await context.newPage();
      try {
        await gallery.setViewportSize({ width: 2000, height: 760 });
        await gallery.setContent(`<!doctype html><body style="margin:0;display:flex;align-items:flex-start;gap:18px;padding:22px;background:#eceae4;font:600 19px system-ui;color:#33343a">${figures.join('')}</body>`);
        await gallery.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth));
        const height = await gallery.evaluate(() =>
          Math.ceil(Math.max(...[...document.querySelectorAll('figure')].map((el) => el.getBoundingClientRect().bottom)) + 22));
        await gallery.screenshot({ path: path.join(DOCS, 'themes.png'), clip: { x: 0, y: 0, width: 2000, height } });
      } finally {
        await gallery.close();
      }

      // The README banner, rendered from docs/hero.html around the real screenshots.
      const hero = await context.newPage();
      try {
        await hero.setViewportSize({ width: 1600, height: 640 });
        for (const scheme of ['light', 'dark']) {
          await hero.goto(`${pathToFileURL(path.join(DOCS, 'hero.html')).href}${scheme === 'dark' ? '#dark' : ''}`);
          await hero.reload(); // a change of #fragment alone does not re-run the page
          await hero.waitForFunction(() => [...document.images].filter((image) => image.offsetParent).every((image) => image.complete && image.naturalWidth));
          await hero.screenshot({ path: path.join(DOCS, `hero-${scheme}.png`) });
        }
      } finally {
        await hero.close();
      }

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

  await step('a click anywhere else on the page closes the bubble', async () => {
    const before = await ext.bubble();
    await page.mouse.click(before.panel.x + 20, before.panel.y + before.panel.height - 70); // inside: stays
    assert.ok(await ext.bubble(), 'a click inside the bubble keeps it open');
    await page.mouse.move(60, 760);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    assert.ok(await ext.bubble(), 'so does a right-click elsewhere');
    await page.keyboard.press('Escape'); // dismisses any context menu; closes the bubble
    await peek(page, '#article');
    await ext.settled();
    await page.mouse.click(60, 760); // empty page area
    assert.equal(await ext.bubble(), null);
    assert.equal(await page.getAttribute('#article', 'style'), null, 'and the link is unmarked');
    await peek(page, '#article');
    await ext.settled();
  });

  await step('Escape closes the bubble and removes it from the page', async () => {
    await page.keyboard.press('Escape');
    assert.equal(await ext.bubble(), null);
    assert.equal(await page.evaluate(() => document.querySelector('linkpeek-bubble')), null);
    assert.equal(await page.getAttribute('#article', 'style'), null, 'the link\'s mark is removed with the bubble');
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

  await step('a link with its own inline styles gets exactly those back', async () => {
    // Start with no bubble open, so no link is marked while its styles are set up.
    await page.keyboard.press('Escape');
    await waitFor(async () => (await ext.bubble()) === null, { what: 'bubble to close' });
    const original = 'color: teal; outline: red dotted 1px; background-color: yellow !important;';
    await page.$eval('#notes', (el, style) => el.setAttribute('style', style), original);
    const before = await page.getAttribute('#notes', 'style');
    await peek(page, '#notes');
    await ext.settled();
    assert.match(await page.$eval('#notes', (el) => el.style.outline), /rgb\(245, 165, 36\)/);
    await peek(page, '#legacy'); // opening another bubble moves the mark
    await ext.settled();
    assert.equal(await page.getAttribute('#notes', 'style'), before, 'restored exactly');
    assert.match(await page.$eval('#legacy', (el) => el.style.outline), /rgb\(245, 165, 36\)/);
    await page.$eval('#notes', (el) => el.removeAttribute('style'));
  });

  await step('a site with no icon keeps its letter, and icons are fetched once per site', async () => {
    assert.equal(server.state.iconRequests, 1, 'many peeks at the same site, one icon request');
    // Another site, which declares no icon and has none at /favicon.ico.
    await page.evaluate((href) => {
      const link = Object.assign(document.createElement('a'), { id: 'other-site', href, textContent: 'A page on another site' });
      document.querySelector('main').prepend(link);
    }, `http://plain.example:${new URL(server.origin).port}/notes.txt`);
    await peek(page, '#other-site');
    const state = await ext.settled();
    await waitFor(() => server.state.faviconByHost['plain.example'] === 1, { what: 'the /favicon.ico attempt' });
    await sleep(200);
    assert.equal(state.error, '');
    assert.equal((await ext.bubble()).icon, null);
    assert.equal((await ext.bubble()).avatar, 'p', 'first letter of plain.example');
    await page.keyboard.press('Escape');
    await page.$eval('#other-site', (el) => el.remove());
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

  await step('five designs: the chosen one is applied, live, to the bubble and its hover card', async () => {
    await peek(page, '#article');
    await ext.settled();
    const expected = {
      light: { background: 'rgb(255, 255, 255)' },
      dark: { background: 'rgb(31, 32, 36)' },
      vision: { background: 'rgb(255, 255, 255)' },
      paper: { background: 'rgb(251, 246, 234)', font: /Palatino|Georgia/ },
      midnight: { background: 'rgba(0, 0, 0, 0)' }, // a translucent gradient, not a flat colour
    };
    for (const [name, look] of Object.entries(expected)) {
      await configure({ sync: { theme: name } });
      const state = await waitFor(async () => {
        const s = await ext.bubble();
        return s?.theme === `lp lp-t-${name}` ? s : null;
      }, { what: `the ${name} design` });
      assert.equal(state.tipTheme, `lp-tip lp-t-${name}`);
      assert.equal(state.background, look.background, name);
      if (look.font) assert.match(state.bodyFont, look.font, `${name} sets its own reading face`);
    }
    // Colour-blind safe: the level is also a number, not only a colour.
    await configure({ sync: { theme: 'vision' } });
    const vision = await waitFor(async () => {
      const s = await ext.bubble();
      return s?.theme.endsWith('vision') && s.reputation ? s : null;
    }, { what: 'the reputation meter in the color-blind safe design' });
    assert.equal(vision.reputation.score, '4/5');
    await configure({ sync: { theme: 'light' } });
    await waitFor(async () => (await ext.bubble())?.theme.endsWith('light'), { what: 'light' });
    assert.equal((await ext.bubble()).reputation.score, '', 'the number is only shown where colour must not carry meaning alone');

    // "Auto" follows the system setting, also while a bubble is open.
    await configure({ sync: { theme: 'auto' } });
    await page.emulateMedia({ colorScheme: 'dark' });
    await waitFor(async () => (await ext.bubble())?.theme === 'lp lp-t-dark', { what: 'auto → dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await waitFor(async () => (await ext.bubble())?.theme === 'lp lp-t-light', { what: 'auto → light' });
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

  await step('"Your key" with no key saved: the bubble points to settings', async () => {
    await configure({ local: { apiKey: '' }, sync: { mode: 'key' } });
    await peek(page, '#article');
    const state = await ext.settled();
    assert.equal(state.error, 'Add your Claude or OpenAI API key in settings to start peeking, or switch to Keyless there.');
    assert.deepEqual(state.buttons, ['Open settings']);
    assert.equal(state.engine, '');
    await page.keyboard.press('Escape');
  });

  await step('"Keyless" in a browser that cannot run it: the bubble says so and points to "Your key"', async () => {
    await configure({ sync: { mode: 'keyless' } });
    await peek(page, '#article');
    const state = await ext.settled();
    assert.match(state.error, /^Keyless cannot run on this computer: Chrome's built-in AI is not available here\. Choose “Your key”/);
    assert.deepEqual(state.buttons, ['Open settings']);
    await page.keyboard.press('Escape');
  });

  // ── Keyless: Chrome's built-in AI ────────────────────────────────────
  // (Keyless stays the chosen mode for the steps below.)
  // The model lives in the extension's hidden page. The stand-in is put there
  // from another extension page, which can reach that window directly.
  const hiddenPage = `chrome.extension.getViews().find((view) => view.location.pathname.includes('offscreen'))`;
  const fakeModel = (config = {}) => admin.evaluate(`(${FAKE_MODEL})(${hiddenPage}, ${JSON.stringify(config)})`);
  const fake = () => admin.evaluate(`JSON.parse(JSON.stringify(${hiddenPage}.__fakeModel))`);
  const setFake = (patch) => admin.evaluate(`void Object.assign(${hiddenPage}.__fakeModel, ${JSON.stringify(patch)})`);
  const ask = async (question) => {
    const { input } = await ext.bubble();
    await page.mouse.click(input.x, input.y);
    await page.keyboard.type(question);
    await page.keyboard.press('Enter');
  };

  await step('Keyless, model not downloaded yet: the first X+click starts it, shows progress, then the summary', async () => {
    await fakeModel({ state: 'downloadable' });
    await peek(page, '#article'); // a real click: the gesture Chrome asks for
    const waiting = await waitFor(async () => {
      const state = await ext.bubble();
      return /Getting Keyless ready: Chrome is downloading its AI model \(about 4 GB, once\)\. \d+%\./.test(state?.status || '') ? state : null;
    }, { what: 'download progress in the bubble' });
    assert.equal(waiting.error, '');
    const state = await ext.settled();
    assert.equal(state.error, '', 'no detour through the settings');
    assert.match(state.text, /summarized on this device/);
    const model = await fake();
    assert.equal(model.state, 'available');
    assert.ok(model.created >= 1);
    await page.keyboard.press('Escape');
  });

  await step('Keyless, opened without a click of its own (context menu): one button in the bubble turns it on', async () => {
    await setFake({ state: 'downloadable', created: 0 }); // as if Chrome had removed the model again
    await clearCache();
    await worker.evaluate(async ({ origin, url }) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      await chrome.tabs.sendMessage(tab.id, { type: 'linkpeek:open', url }, { frameId: 0 });
    }, { origin: server.origin, url: `${server.origin}/article.html` });
    let state = await ext.settled();
    assert.equal(state.error, "One step left: Keyless needs Chrome's AI model, a free one-time download of about 4 GB.");
    assert.deepEqual(state.buttons, ['Turn on Keyless', 'Open settings', 'Try again']);
    assert.equal((await fake()).created, 0, 'nothing is downloaded behind the reader\'s back');

    await page.mouse.click(state.buttonAt['Turn on Keyless'].x, state.buttonAt['Turn on Keyless'].y);
    state = await ext.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /summarized on this device/);
    assert.equal((await fake()).state, 'available');
    await page.keyboard.press('Escape');
  });

  await step("Keyless: Chrome's built-in AI summarizes on this computer, in the same shape as with a key", async () => {
    await setFake({ state: 'available', prompts: [], ratings: [] });
    await worker.evaluate(() => chrome.storage.session.remove('ratings')); // ratings from earlier steps
    const sent = server.requests.length;
    const rated = server.reputationRequests.length;
    await peek(page, '#article');
    const state = await ext.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /TL;DR: How a sourdough starter actually works, summarized on this device\./);
    assert.equal((state.html.match(/<li>/g) || []).length, 2, 'the Markdown is rendered as usual');
    assert.ok(!state.text.includes('summary>'), "the model's own wrapper tag is not shown");
    assert.equal(state.engine, 'AI running on this device', 'the footer says who answered');
    assert.match(state.html, /<strong><em class="lp-tldr">TL;DR:<\/em><\/strong>/, 'the same TL;DR opening as a summary made with a key');
    assert.equal(state.credit, 'Author: Mara Lindqvist, October 3, 2026', 'the header (author, date, reading time) needs no model');
    assert.match(state.sub, /^127\.0\.0\.1 · \d+ min read$/);
    assert.equal(server.requests.length, sent, 'nothing was sent to an AI service');
    assert.equal(server.reputationRequests.length, rated);

    // The reputation meter is there too, rated on this computer, after the summary.
    const { reputation } = await waitFor(async () => {
      const now = await ext.bubble();
      return now?.reputation ? now : null;
    }, { what: 'the on-device source rating' });
    assert.equal(reputation.label, 'High');
    assert.equal(reputation.bars, 4);
    assert.match(reputation.aria, /Why: An established food magazine with editorial standards\. Decided by Chrome’s small on-device AI .* A rough estimate, not a verified rating\.$/);
    const { ratings } = await fake();
    assert.equal(ratings.length, 1);
    assert.equal(ratings[0].duringAnswer, false, 'the rating waited for the summary');
    assert.ok(ratings[0].input[0].content.includes('<author>Mara Lindqvist</author>'), 'who published the page');
    assert.ok(!ratings[0].input[0].content.includes('A sourdough starter is not an ingredient'), 'and nothing of what it says');
    assert.equal(server.reputationRequests.length, rated, 'no rating request left this computer either');

    const { prompts } = await fake();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].system, /^You are LinkPeek\. The reader has not opened a web page/);
    assert.ok(prompts[0].system.includes('**TL;DR:** one sentence'), 'the set shape');
    assert.ok(!prompts[0].system.includes('Keep it under 150 words'), "the reader's own format prompt is for their key");
    assert.ok(prompts[0].system.includes('Write in English.'));
    assert.deepEqual(prompts[0].languages, ['en']);
    const [{ role, content }] = prompts[0].input;
    assert.equal(role, 'user');
    assert.ok(content.includes('A sourdough starter is not an ingredient'), 'the page text');
    assert.ok(!content.includes('NAV_NOISE'), 'cleaned the same way as for any other model');
    assert.ok(content.endsWith('Summarize this page for me, following my preferred format.'));
  });

  await step('Keyless: a source the on-device model only guesses at is shown as Unknown, not as its guess', async () => {
    await page.keyboard.press('Escape');
    await worker.evaluate(async ({ origin, url }) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      await chrome.tabs.sendMessage(tab.id, { type: 'linkpeek:open', url }, { frameId: 0 });
    }, { origin: server.origin, url: `${server.origin}/passkeys.html` });
    const state = await ext.settled();
    assert.equal(state.error, '');
    const { reputation } = await waitFor(async () => {
      const now = await ext.bubble();
      return now?.reputation ? now : null;
    }, { what: 'the on-device source rating' });
    const { ratings } = await fake();
    assert.ok(ratings.at(-1).input[0].content.includes('<publisher>The Byte Review</publisher>'));
    assert.equal(reputation.label, 'Unknown', 'the model said 3 "Mixed" while admitting it does not know the source');
    assert.equal(reputation.bars, 0);
    await page.keyboard.press('Escape');
    // Back to the article, for the steps that follow.
    await peek(page, '#article', { keepCache: true });
    await ext.settled();
  });

  await step('a follow-up question is answered on this computer too', async () => {
    await ask('How often should I feed it?');
    const state = await ext.settled(3);
    assert.equal(state.error, '');
    assert.match(state.text, /On this device: How often should I feed it\?$/);
    const { prompts } = await fake();
    assert.deepEqual(prompts.at(-1).input.map((message) => message.role), ['user', 'assistant', 'user']);
    assert.match(prompts.at(-1).input[1].content, /summarized on this device/, 'the summary is part of the conversation');
    await page.keyboard.press('Escape');
  });

  await step('the second peek at the same page uses the saved on-device summary', async () => {
    const { prompts } = await fake();
    await peek(page, '#article', { keepCache: true });
    const state = await ext.settled();
    assert.match(state.notes.join(' '), /^Saved summary from /);
    assert.equal(state.engine, 'AI running on this device');
    assert.equal((await fake()).prompts.length, prompts.length, 'the model was not asked again');
    await page.keyboard.press('Escape');
  });

  await step('a page too long for the built-in model is cut, and the bubble says so', async () => {
    // A context window some 40 tokens too small for this page (the stand-in
    // counts four characters as a token; 1,080 tokens are kept for the answer).
    const [seen] = (await fake()).prompts;
    await setFake({ window: Math.ceil(seen.system.length / 4) + Math.ceil(seen.input[0].content.length / 4) + 1080 - 40 });
    await peek(page, '#article');
    const state = await ext.settled();
    await setFake({ window: 9216 });
    assert.equal(state.error, '');
    assert.match(state.notes.join(' '), /^Long page: Keyless read about the first \d+ words\. With your own key, LinkPeek reads much longer pages\.$/);
    const { content } = (await fake()).prompts.at(-1).input[0];
    assert.ok(content.includes('Only its first part is included'), 'the model is told too');
    assert.ok(content.includes('A sourdough starter is not an ingredient'), 'the beginning is kept');
    assert.ok(!content.includes('starter : flour : water'), 'the end is what is dropped');
    await page.keyboard.press('Escape');
  });

  await step('Stop reaches the on-device model, and what arrived is kept', async () => {
    await setFake({ hang: true });
    await peek(page, '#article');
    const partial = await waitFor(async () => {
      const state = await ext.bubble();
      return state?.busy && state.text.includes('TL;DR') ? state : null;
    }, { what: 'the answer to start' });
    await page.mouse.click(partial.send.x, partial.send.y);
    const state = await ext.settled();
    await setFake({ hang: false });
    assert.match(state.text, /Stopped\.$/);
    await waitFor(async () => (await fake()).aborted === 1, { what: 'the model to be told to stop' });
    await page.keyboard.press('Escape');
  });

  await step('a PDF is beyond Keyless: the bubble says so, with a way forward', async () => {
    const { prompts } = await fake();
    await peek(page, '#pdf');
    const state = await ext.settled();
    assert.equal(state.error, 'Keyless cannot read PDFs. Switch to “Your key” in settings to peek at PDFs.');
    assert.deepEqual(state.buttons, ['Open settings']);
    assert.equal((await fake()).prompts.length, prompts.length);
    await page.keyboard.press('Escape');
  });

  await step('the choice is the reader\'s: a saved key does not switch Keyless off, and "Your key" uses the key', async () => {
    await configure({ local: anthropic }); // a key is saved; the mode is still Keyless
    const sent = server.requests.length;
    const rated = server.reputationRequests.length;
    await peek(page, '#article');
    let state = await ext.settled();
    assert.match(state.text, /summarized on this device/);
    assert.equal(state.engine, 'AI running on this device');
    assert.equal(server.requests.length, sent, 'the key is there, and is not used');
    assert.equal(server.reputationRequests.length, rated, 'not for a reputation rating either');
    await page.keyboard.press('Escape');

    await configure({ sync: { mode: 'key' } });
    const { prompts } = await fake();
    await peek(page, '#article');
    state = await ext.settled();
    assert.match(state.text, /TL;DR: A sourdough starter is a stable culture/, 'the summary comes from Claude');
    assert.equal(state.engine, viaMock);
    assert.equal(server.requests.length, sent + 1);
    assert.equal((await fake()).prompts.length, prompts.length, 'and the built-in model is left alone');
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
    await configure({ local: anthropic, sync: { format: 'placeholder', mode: 'key' } });
    const options = await context.newPage();
    // The screenshot shows the settings as they look in Chrome proper.
    if (SHOTS) await options.addInitScript(`(${FAKE_MODEL})(globalThis, {})`);
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

    // Design: six choices, saved on click.
    assert.deepEqual(await options.$$eval('#themes .theme', (els) => els.map((el) => el.textContent)),
      ['Auto', 'Light', 'Dark', 'Color-blind safe', 'Paper', 'Midnight']);
    assert.equal(await options.getAttribute('#themes [data-theme="auto"]', 'aria-checked'), 'true');
    await options.click('#themes [data-theme="paper"]');
    await options.waitForSelector('#saved-design.show');
    assert.equal(await options.getAttribute('#themes [data-theme="paper"]', 'aria-checked'), 'true');
    assert.equal((await stored()).theme, 'paper');
    assert.match(await options.textContent('#theme-hint'), /book typeface/);
    await options.click('#themes [data-theme="auto"]');
    await waitFor(async () => (await stored()).theme === 'auto', { what: 'design reset to be stored' });

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

  const storedPrefs = () => worker.evaluate(() => chrome.storage.sync.get(null));
  const savedKey = () =>
    admin.evaluate(async () => {
      const { loadSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
      return (await loadSettings()).apiKey;
    });
  const chosen = (options) =>
    options.$$eval('#modes .mode', (tiles) => tiles.filter((tile) => tile.getAttribute('aria-checked') === 'true').map((tile) => tile.dataset.mode));

  await step('settings: two choices, Keyless and Your key, each saying what it can and cannot do', async () => {
    await configure({ local: anthropic, sync: { mode: 'key' } });
    const options = await context.newPage();
    await options.goto(optionsUrl);
    const tiles = await options.$$eval('#modes .mode', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ')));
    assert.equal(tiles.length, 2);
    assert.match(tiles[0], /^Keyless free Chrome's built-in AI, on this computer\./);
    assert.match(tiles[0], /Short summaries in one set format: a TL;DR and key points\. A few languages only: English, Spanish, Japanese, German, French\./);
    assert.match(tiles[1], /^Your key best quality Your own Claude or OpenAI key\./);
    assert.match(tiles[1], /Any format you describe, however long or detailed\. Almost any language\./);

    // Your key is chosen: its panel is shown, Keyless's is not.
    assert.deepEqual(await chosen(options), ['key']);
    assert.equal(await options.isVisible('#api-key'), true);
    assert.equal(await options.isHidden('#builtin-status'), true);
    assert.equal(await options.isVisible('#format'), true, 'the Summary format box belongs to Your key');

    // Choosing Keyless here, where the browser cannot run it: said plainly, nothing to click.
    await options.click('#modes .mode[data-mode="keyless"]');
    await options.waitForSelector('#builtin-status[data-state="unsupported"]');
    assert.deepEqual(await chosen(options), ['keyless']);
    assert.match(await options.textContent('#builtin-status'), /^Keyless cannot run in this browser\. It needs Chrome 138 or newer on a computer\. Choose “Your key” instead\.$/);
    assert.equal(await options.isHidden('#builtin-on'), true);
    assert.equal(await options.isHidden('#api-key'), true);
    assert.equal(await options.isHidden('#format-card'), true, 'Keyless has one set format: no Summary format box');
    assert.equal(await options.isVisible('#themes'), true, 'the rest of the settings stay');
    await waitFor(async () => (await storedPrefs()).mode === 'keyless', { what: 'the choice to be saved' });
    assert.equal(await savedKey(), 'sk-ant-test-key', 'switching to Keyless keeps the saved key');

    await options.click('#modes .mode[data-mode="key"]');
    assert.equal(await options.isVisible('#api-key'), true);
    assert.equal(await options.isVisible('#format-card'), true, 'and back again with Your key');
    assert.equal(await options.inputValue('#api-key'), 'sk-ant-test-key');
    await waitFor(async () => (await storedPrefs()).mode === 'key', { what: 'the choice to be saved' });
    await options.close();
  });

  await step('settings: choosing Keyless starts the model download at once, with progress', async () => {
    const options = await context.newPage();
    await options.addInitScript(`(${FAKE_MODEL})(globalThis, { state: 'downloadable' })`);
    await options.goto(optionsUrl);
    await options.click('#modes .mode[data-mode="keyless"]'); // the click Chrome asks for
    await waitFor(async () => /Downloading Chrome’s AI model… 42%/.test(await options.textContent('#builtin-status')), { what: 'download progress' });
    assert.equal(await options.isHidden('#builtin-on'), true, 'nothing left to click while it downloads');
    assert.equal(await options.evaluate(() => document.getElementById('builtin-progress').value), 0.42);
    await options.waitForSelector('#builtin-status.ok');
    assert.equal(await options.textContent('#builtin-status'), '✓ Ready on this computer. Hold X and click any link.');
    assert.equal(await options.isHidden('#builtin-on'), true);
    assert.equal(await options.isHidden('#builtin-progress'), true);
    await waitFor(async () => (await storedPrefs()).mode === 'keyless', { what: 'the choice to be saved' });
    await options.close();
  });

  await step('settings, right after installing: the download waits for a click (Chrome insists), then takes the first one', async () => {
    await configure({ local: { apiKey: '' }, sync: { mode: 'keyless' } });
    const fresh = async () => {
      const options = await context.newPage();
      await options.addInitScript(`(${FAKE_MODEL})(globalThis, { state: 'downloadable' })`);
      await options.goto(optionsUrl);
      await options.waitForSelector('#builtin-status[data-state="downloadable"]');
      return options;
    };
    const created = (options) => options.evaluate(() => globalThis.__fakeModel.created);

    // Nothing has been clicked: nothing is downloaded, and the page says what will happen.
    let options = await fresh();
    await sleep(600);
    assert.equal(await created(options), 0);
    assert.match(await options.textContent('#builtin-status'), /^One step left: Chrome downloads its AI model once \(about 4 GB\)\. It starts with your first click on this page, or with your first peek\./);
    assert.equal(await options.textContent('#builtin-on'), 'Turn on');
    // Any click will do. Here: on the page's heading, not on the button.
    await options.click('h1');
    await options.waitForSelector('#builtin-status.ok');
    assert.equal(await created(options), 1);
    await options.close();

    // Except the click that says "not Keyless".
    options = await fresh();
    await options.click('#modes .mode[data-mode="key"]');
    await sleep(600);
    assert.equal(await created(options), 0, 'choosing Your key downloads nothing');
    assert.equal(await options.evaluate(() => globalThis.__fakeModel.state), 'downloadable');
    await options.close();
  });

  await step('settings: the first visit starts from what this computer can do, then never chooses again', async () => {
    const firstVisit = async ({ key, model }) => {
      await configure({ local: { apiKey: key }, sync: { mode: '' } });
      const options = await context.newPage();
      if (model) await options.addInitScript(`(${FAKE_MODEL})(globalThis, { state: '${model}' })`);
      await options.goto(optionsUrl);
      await waitFor(async () => (await storedPrefs()).mode, { what: 'a starting choice' });
      const result = { stored: (await storedPrefs()).mode, shown: await chosen(options) };
      await options.close();
      return result;
    };
    assert.deepEqual(await firstVisit({ key: '', model: 'available' }), { stored: 'keyless', shown: ['keyless'] }, 'a computer that can: Keyless');
    assert.deepEqual(await firstVisit({ key: '', model: 'downloadable' }), { stored: 'keyless', shown: ['keyless'] });
    assert.deepEqual(await firstVisit({ key: '', model: '' }), { stored: 'key', shown: ['key'] }, 'a computer that cannot: Your key');
    assert.deepEqual(await firstVisit({ key: 'sk-ant-test-key', model: 'available' }), { stored: 'key', shown: ['key'] }, 'someone who already has a key keeps using it');

    // Once chosen, pasting or removing a key does not move the choice.
    await configure({ local: { apiKey: '' }, sync: { mode: 'keyless' } });
    const options = await context.newPage();
    await options.addInitScript(`(${FAKE_MODEL})(globalThis, {})`);
    await options.goto(optionsUrl);
    await options.waitForSelector('#builtin-status.ok');
    await configure({ local: { apiKey: 'sk-ant-test-key' } });
    await options.reload();
    await options.waitForSelector('#builtin-status.ok');
    assert.deepEqual(await chosen(options), ['keyless']);
    assert.equal((await storedPrefs()).mode, 'keyless');
    await options.close();
    await configure({ local: anthropic, sync: { mode: 'key' } });
  });

  await step('toolbar popup shows the same settings, compact', async () => {
    const popup = await context.newPage();
    await popup.goto(`${optionsUrl}?popup=1`);
    assert.equal(await popup.evaluate(() => document.documentElement.classList.contains('popup')), true);
    assert.equal(await popup.evaluate(() => getComputedStyle(document.body).width), '400px');
    await popup.close();
  });

  // ── Embedded frames ──────────────────────────────────────────────────
  const framed = await context.newPage();
  await framed.goto(`${server.origin}/frames.html`);
  await framed.bringToFront();
  const frameOf = async (id) => (await framed.$(`#${id}`)).contentFrame();
  const topExt = await attach(framed, extensionId);
  // Hold X with the focus in `holder` (the page or a frame), click in `where`.
  const peekAcross = async (holder, focusOn, where, selector) => {
    await holder.click(focusOn); // the key press will land where the focus is
    await framed.keyboard.down('x');
    await sleep(250); // a person holds the key for at least this long before clicking
    await where.click(selector);
    await framed.keyboard.up('x');
  };

  await step('a link inside an embedded frame: X held in the page, click in the frame, bubble in the frame', async () => {
    const same = await frameOf('same');
    const sameExt = await attach(framed, extensionId, same);
    const address = same.url();
    await peekAcross(framed, 'h1', same, '#article');
    const state = await sameExt.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /TL;DR: A sourdough starter/);
    assert.equal(same.url(), address, 'the frame did not navigate');
    assert.equal(await topExt.bubble(), null, 'the bubble is where the link is, not in the page around it');
    assert.equal(context.pages().length, tabs + 1, 'and no tab was opened');
  });

  await step('a frame from another site works the same, and there is only ever one bubble on the page', async () => {
    const cross = await frameOf('cross');
    assert.match(cross.url(), /^http:\/\/embedded\.example:/);
    const crossExt = await attach(framed, extensionId, cross);
    const sameExt = await attach(framed, extensionId, await frameOf('same'));
    assert.ok(await sameExt.bubble(), 'the bubble from the step before is still open');
    await peekAcross(framed, 'h1', cross, '#article');
    const state = await crossExt.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /TL;DR: A sourdough starter/);
    await waitFor(async () => (await sameExt.bubble()) === null, { what: 'the other frame to close its bubble' });
  });

  await step('a sandboxed frame whose link opens a new tab (an artifact page): X+click peeks instead', async () => {
    const boxed = await frameOf('boxed');
    const boxedExt = await attach(framed, extensionId, boxed);
    await peekAcross(framed, 'h1', boxed, '#out');
    const state = await boxedExt.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /TL;DR: A sourdough starter/);
    assert.equal(context.pages().length, tabs + 1, 'the link did not open its new tab');
    await framed.keyboard.press('Escape');
  });

  await step('the other way round: X held inside a frame, click on a link in the page', async () => {
    const same = await frameOf('same');
    await peekAcross(same, 'h1', framed, '#top-link');
    const state = await topExt.settled();
    assert.equal(state.error, '');
    assert.match(state.text, /TL;DR: A sourdough starter/);
    assert.equal(framed.url(), `${server.origin}/frames.html`);
    await framed.keyboard.press('Escape');
    await waitFor(async () => (await topExt.bubble()) === null, { what: 'the bubble to close' });
  });

  await step('a frame too small for a bubble hands it to the page around it', async () => {
    const small = await frameOf('small');
    const smallExt = await attach(framed, extensionId, small);
    await peekAcross(framed, 'h1', small, '#article');
    const state = await topExt.settled();
    assert.equal(state.error, '');
    assert.equal(state.title, 'How a sourdough starter actually works');
    assert.equal(await smallExt.bubble(), null);
    await framed.keyboard.press('Escape');
  });

  await step('once the key is released, clicks inside frames are ordinary clicks again', async () => {
    const same = await frameOf('same');
    const sameExt = await attach(framed, extensionId, same);
    await framed.click('h1');
    await framed.keyboard.press('x'); // down and up, in the page
    await sleep(250);
    await same.click('#hash'); // a same-page anchor: harmless to follow
    await sleep(400);
    assert.equal(await sameExt.bubble(), null);
    assert.match(same.url(), /#top$/);
    await framed.close();
    await page.bringToFront();
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
