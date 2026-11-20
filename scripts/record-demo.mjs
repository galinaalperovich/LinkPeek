// Records docs/demo.gif: the real extension, in a real browser, on a real
// website (the Playwright repository on GitHub), peeking at a real link.
//
//   npm run demo
//
// What is real: the page, the link, the page LinkPeek reads behind it, the
// site icon, the streaming, every pixel of the bubble.
// What is scripted: the words of the summary. No API key is used; a local
// stand-in for the Claude API replays a summary that was written from the
// text LinkPeek extracted from that page. Re-record after the page changes.
//
// Needs network access, ffmpeg, and `npm install` (Playwright).

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/e2e/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'demo.gif');
const SIZE = { width: 960, height: 600 };
const FPS = 12;
const START_URL = 'https://github.com/microsoft/playwright';
const LINK = 'article a[href*="playwright.dev"]';

const SCRIPT = {
  summary: `**TL;DR:** Playwright is a framework for automating and testing web apps in Chromium, Firefox and WebKit, with tools for test suites and for AI agents.

- **Three ways in:** Playwright Test (a full test runner), a CLI for coding agents, and an MCP server that gives AI agents browser control.
- **Built for testing:** auto-waiting and retrying assertions, a fresh browser context per test, locators such as \`getByRole\`, and parallel runs with sharding.
- **Built for agents:** pages are exposed as accessibility snapshots, not screenshots, so no vision model is needed.
- **Tooling:** a test generator that records your actions, a Trace Viewer, and a VS Code extension.
- **Reach:** Linux, macOS and Windows; also for Python, .NET and Java.

Worth knowing: this is the project's own landing page, so it lists strengths, not trade-offs.`,
  answer: 'Run `npm init playwright@latest` for the test runner. For coding agents, the page gives `npm i -g @playwright/cli@latest`, and `npx @playwright/mcp@latest` for the MCP server.',
  rating: '{"level": 4, "reason": "Official site of the Playwright project, describing its own product"}',
};
const QUESTION = 'How do I install it?';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = await startServer();
server.state.script = SCRIPT;
server.state.chunkDelay = 38; // slow enough to see the summary stream in

const work = await mkdtemp(path.join(tmpdir(), 'linkpeek-demo-'));
const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: SIZE,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run'],
});

try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  await sleep(600);
  const admin = context.pages().find((p) => p.url().includes('options')) || (await context.newPage());
  if (!admin.url().includes('options')) await admin.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await admin.evaluate(async (patch) => {
    const { saveSettings } = await import(chrome.runtime.getURL('src/lib/settings.js'));
    await saveSettings(patch);
  }, { apiKey: 'sk-ant-demo-recording', baseUrl: `${server.origin}/anthropic`, theme: 'light' });

  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'load' });
  await page.bringToFront();
  const link = page.locator(LINK).first();
  await link.scrollIntoViewIfNeeded();
  await page.evaluate((selector) => {
    const top = document.querySelector(selector).getBoundingClientRect().top;
    window.scrollBy(0, top - 150);
  }, LINK);
  await sleep(500);

  // A screenshot has no mouse pointer and shows no keys. Draw both, so the
  // gesture (hold X, click) can be seen. Top layer, to stay above the bubble.
  await page.evaluate(() => {
    const make = (css) => {
      const el = document.createElement('div');
      el.popover = 'manual';
      el.style.cssText = `all: initial; position: fixed; margin: 0; padding: 0; border: 0; pointer-events: none; overflow: visible; background: transparent; ${css}`;
      document.documentElement.append(el);
      return el;
    };
    const cursor = make('left: 0; top: 0; width: 22px; height: 22px;');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('d', 'M4 2l15 9.500-6.800 1.300L16 20.500l-3.200 1.500-3.800-7.700L4 19z');
    arrow.setAttribute('fill', '#111');
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.4');
    svg.append(arrow);
    cursor.append(svg);
    const key = make('left: 24px; bottom: 22px; top: auto; padding: 9px 16px; border-radius: 12px; background: #1b1c1f; color: #fff; font: 600 15px system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.3); opacity: 0; transition: opacity .15s;');
    key.textContent = 'Holding  X';
    const raise = () => {
      for (const el of [cursor, key]) {
        try { el.hidePopover(); } catch {}
        el.showPopover();
      }
    };
    raise();
    window.__demo = { raise };
    window.addEventListener('mousemove', (e) => {
      cursor.style.left = `${e.clientX - 3}px`;
      cursor.style.top = `${e.clientY - 2}px`;
    }, true);
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyX' && !e.target.closest?.('linkpeek-bubble')) key.style.opacity = '1'; }, true);
    window.addEventListener('keyup', (e) => { if (e.code === 'KeyX') key.style.opacity = '0'; }, true);
  });

  // Frames are captured as fast as the browser gives them, with real timestamps.
  const frames = [];
  let recording = true;
  const capture = (async () => {
    while (recording) {
      const file = path.join(work, `frame-${String(frames.length).padStart(4, '0')}.png`);
      const at = Date.now();
      await page.screenshot({ path: file });
      frames.push({ file, at });
      await sleep(Math.max(0, 1000 / FPS - (Date.now() - at)));
    }
  })();

  const bubble = (expression) => page.evaluate(() => null).then(() => expression); // placeholder to keep the flow readable
  const glide = async (x, y, steps = 18) => {
    await page.mouse.move(x, y, { steps });
    await sleep(120);
  };
  const center = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  // 1. The page, then the pointer travels to the link.
  await page.mouse.move(700, 430);
  await sleep(900);
  const target = await center(link);
  await glide(target.x, target.y, 26);
  await sleep(350);

  // The bubble lives in the content script's own world: reach it from there.
  const cdp = await context.newCDPSession(page);
  const worlds = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context: c }) => worlds.set(c.id, c));
  await cdp.send('Runtime.enable');
  const inExtension = async (expression) => {
    const world = [...worlds.values()].find((c) => c.auxData?.type === 'isolated' && String(c.origin).includes(extensionId));
    const { result } = await cdp.send('Runtime.evaluate', { expression, contextId: world.id, returnByValue: true });
    return result.value;
  };
  // The stand-in for the API is at a local address, and that address is what
  // the bubble's footer would name. A reader with a Claude key sees the
  // company's name there, so that is what the recording shows.
  await sleep(200);
  await inExtension(`void setInterval(() => {
    const el = globalThis.__linkpeek?.bubble?.engineEl;
    if (el && !el.hidden && el.textContent !== 'AI provided by Anthropic') el.textContent = 'AI provided by Anthropic';
  }, 16)`);

  // 2. Hold X, click.
  await page.keyboard.down('x');
  await sleep(550);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(350);
  await page.keyboard.up('x');
  await page.evaluate(() => window.__demo.raise());

  // 3. The summary streams in. The bubble is in a closed shadow root, so its
  //    geometry is read from the host element's own box and known layout.
  await sleep(600);
  const waitUntil = async (check, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await sleep(120);
    }
    throw new Error('timed out');
  };
  await waitUntil(() => server.requests.length >= 1);
  await sleep(SCRIPT.summary.length / 14 * server.state.chunkDelay + 2200);

  // 4. Point at the reputation meter: its explanation appears.
  const spot = (name) => inExtension(`(() => { const r = globalThis.__linkpeek.bubble.${name}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const meter = await spot('repEl');
  await glide(meter.x, meter.y, 16);
  await sleep(2600);

  // 5. Ask a question.
  const input = await spot('input');
  await glide(input.x, input.y, 16);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.type(QUESTION, { delay: 55 });
  await sleep(350);
  await page.keyboard.press('Enter');
  await waitUntil(() => server.requests.length >= 2);
  await sleep(SCRIPT.answer.length / 14 * server.state.chunkDelay + 600);
  await glide(820, 520, 14);
  await sleep(2600);

  recording = false;
  await capture;

  // Frames → GIF, each frame shown for as long as it really lasted.
  const list = frames.map((frame, i) => {
    const next = frames[i + 1]?.at ?? frame.at + 1000 / FPS;
    return `file '${frame.file}'\nduration ${((next - frame.at) / 1000).toFixed(3)}`;
  });
  list.push(`file '${frames.at(-1).file}'`);
  const concat = path.join(work, 'frames.txt');
  await writeFile(concat, list.join('\n'));
  await mkdir(path.dirname(OUT), { recursive: true });
  const palette = path.join(work, 'palette.png');
  const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];
  const filters = `fps=${FPS},scale=${SIZE.width}:-1:flags=lanczos`;
  execFileSync('ffmpeg', [...quiet, '-f', 'concat', '-safe', '0', '-i', concat, '-vf', `${filters},palettegen=max_colors=160:stats_mode=diff`, palette]);
  execFileSync('ffmpeg', [...quiet, '-f', 'concat', '-safe', '0', '-i', concat, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', OUT]);
  console.log(`${frames.length} frames over ${((frames.at(-1).at - frames[0].at) / 1000).toFixed(1)} s → ${path.relative(ROOT, OUT)}`);
  if (process.env.KEEP_FRAMES) console.log(`frames kept in ${work}`);
} finally {
  await context.close();
  await server.close();
  if (!process.env.KEEP_FRAMES) await rm(work, { recursive: true, force: true });
}
