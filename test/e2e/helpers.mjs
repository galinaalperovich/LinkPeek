// Shared by the end-to-end tests (run.mjs, a stand-in model in Chromium) and
// the on-device test (../ondevice/run.mjs, the real model in Chrome).

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, { timeout = 15_000, what = 'condition' } = {}) {
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
    avatar: b.avatarEl.textContent,
    // The colour in the middle of the site icon, when a real icon was drawn.
    icon: (() => {
      const canvas = b.avatarEl.querySelector('canvas');
      return canvas ? [...canvas.getContext('2d').getImageData(32, 32, 1, 1).data] : null;
    })(),
    href: b.titleEl.getAttribute('href'),
    sub: [b.hostEl.textContent, b.factsEl.textContent].filter(Boolean).join(' '),
    credit: b.creditEl.hidden ? '' : b.creditEl.textContent,
    reputation: b.repEl.hidden ? null : {
      label: b.repEl.querySelector('.lp-rep-label').textContent,
      score: (() => {
        const el = b.repEl.querySelector('.lp-rep-score'); // absent for "Unknown"
        return el && getComputedStyle(el).display !== 'none' ? el.textContent : '';
      })(),
      bars: b.repEl.querySelectorAll('.lp-meter i.on').length,
      tone: b.repEl.className,
      aria: b.repEl.getAttribute('aria-label'),
      tip: b.tipEl.hidden ? '' : b.tipEl.innerText,
      tipBox: b.tipEl.hidden ? null : (({ x, y, width, height }) => ({ x, y, width, height }))(b.tipEl.getBoundingClientRect()),
      at: center(b.repEl),
    },
    text: b.body.innerText,
    html: b.body.innerHTML,
    engine: b.engineEl.hidden ? '' : b.engineEl.textContent,
    notes: [...b.body.querySelectorAll('.lp-note')].map((el) => el.textContent),
    busy: b.busy,
    turns: b.history.length,
    status: b.statusEl.hidden ? '' : b.statusText.textContent,
    error: b.body.querySelector('.lp-error-msg')?.textContent || '',
    buttons: [...b.body.querySelectorAll('.lp-btn')].map((el) => el.textContent),
    buttonAt: Object.fromEntries([...b.body.querySelectorAll('.lp-btn')].map((el) => [el.textContent, center(el)])),
    footSize: getComputedStyle(b.engineEl).fontSize,
    inputDisabled: b.input.disabled,
    input: center(b.input),
    send: center(b.sendBtn),
    again: b.body.querySelector('.lp-linkbtn') ? center(b.body.querySelector('.lp-linkbtn')) : null,
    close: center(b.head.querySelector('button[aria-label="Close"]')),
    head: { x: panel.x + 150, y: panel.y + 20 },
    panel: { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
    topLayer: b.host.matches(':popover-open'),
    theme: b.panel.className,
    fontSize: getComputedStyle(b.panel).fontSize,
    titleAt: center(b.titleEl),
    tip: b.tipEl.hidden ? '' : b.tipEl.innerText,
    tipTheme: b.tipEl.className,
    background: getComputedStyle(b.panel).backgroundColor,
    bodyFont: getComputedStyle(b.body.querySelector('.lp-md') || b.body).fontFamily,
  };
})()`;

/**
 * A handle on the content script of the page, or of one frame inside it. Each
 * frame runs its own copy; a frame from another site lives in its own process
 * and has its own DevTools session.
 */
export async function attach(page, extensionId, frame = null) {
  let cdp;
  let frameUrl = null; // set when the frame shares the page's session
  if (frame) {
    try {
      cdp = await page.context().newCDPSession(frame);
    } catch {
      cdp = await page.context().newCDPSession(page);
      frameUrl = frame.url();
    }
  } else {
    cdp = await page.context().newCDPSession(page);
  }
  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable');

  const frameId = async () => {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    if (!frameUrl) return frameTree.frame.id; // the page itself, or the root of a frame's own session
    const find = (node) => (node.frame.url === frameUrl ? node.frame.id : (node.childFrames || []).map(find).find(Boolean));
    return find(frameTree);
  };

  const evaluate = async (expression) => {
    const id = await frameId();
    const world = [...contexts.values()].find(
      (context) =>
        context.auxData?.type === 'isolated' && String(context.origin).includes(extensionId) && context.auxData.frameId === id,
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
    settled: (turns = 1, timeout = 15_000) =>
      waitFor(async () => {
        const state = await evaluate(BUBBLE_STATE);
        return state && !state.busy && (state.turns >= turns || state.error) ? state : null;
      }, { timeout, what: `bubble to settle with ${turns} turn(s)` }),
  };
}

