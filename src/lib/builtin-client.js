// The service worker's side of Chrome's built-in AI. The model itself is only
// reachable from a window, so the work happens in the offscreen page
// (offscreen/builtin-host.js) and comes back here as a stream of events.

import { ensureOffscreen } from './page-loader.js';
import { ProviderError } from './providers.js';

// The host sends a sign of life every few seconds. This long without one
// means the offscreen page is gone or stuck.
const SILENCE_MS = 40_000;
const waiting = new Map(); // request id → (event) => void

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background' || message.type !== 'builtin:event') return undefined;
  if (sender.id !== chrome.runtime.id || sender.tab) return undefined; // our offscreen page only
  const deliver = waiting.get(message.id);
  deliver?.(message.event);
  sendResponse({ ok: Boolean(deliver) }); // "not ok" tells the host to stop working
  return undefined;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function toOffscreen(message) {
  await ensureOffscreen();
  const full = { target: 'offscreen', ...message };
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage(full);
      if (reply || attempt) return reply;
    } catch (err) {
      if (attempt) throw err;
    }
    await sleep(200); // the page was created a moment ago and is still loading
  }
}

/**
 * Where the built-in model stands: `state` as in builtinState() in
 * builtin-ai.js, and `turningOn` while it is being switched on (downloaded or
 * woken) after a click. Never throws.
 */
export async function builtinStatus(lang = 'en') {
  const reply = await toOffscreen({ type: 'builtin:state', lang }).catch(() => null);
  return { state: reply?.state || 'unsupported', turningOn: Boolean(reply?.turningOn) };
}

/** Start loading the model, so it is awake by the time the page has been read. */
export function warmBuiltin() {
  toOffscreen({ type: 'builtin:warm' }).catch(() => {});
}

/**
 * Streams an answer made on this computer.
 * @param {{ system: string, lang: string, page: object, linkText: string,
 *           history: object[], question: string }} request
 * Yields { type: 'status', stage, progress? }, { type: 'text', text } and finally
 *        { type: 'done', stopReason, detail, notice }.
 */
export async function* streamBuiltin(request, signal) {
  const id = crypto.randomUUID();
  const queue = [];
  let wake = null;
  const push = (event) => {
    queue.push(event);
    wake?.();
  };
  const onAbort = () => push({ type: 'aborted' });
  waiting.set(id, push);
  signal?.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    await toOffscreen({ type: 'builtin:start', id, request });
    for (;;) {
      if (!queue.length) {
        const silence = setTimeout(() => push({ type: 'silent' }), SILENCE_MS);
        await new Promise((resolve) => {
          wake = resolve;
        });
        clearTimeout(silence);
        wake = null;
      }
      const event = queue.shift();
      if (!event || event.type === 'alive') continue;
      if (event.type === 'aborted') throw new DOMException('The request was cancelled.', 'AbortError');
      if (event.type === 'silent') {
        throw new ProviderError("Chrome's built-in AI stopped answering. Try again.", { code: 'builtin' });
      }
      if (event.type === 'error') {
        finished = true;
        throw new ProviderError(event.message, { code: event.code, detail: event.detail });
      }
      yield event;
      if (event.type === 'done') {
        finished = true;
        return;
      }
    }
  } finally {
    waiting.delete(id);
    signal?.removeEventListener('abort', onAbort);
    if (!finished) toOffscreen({ type: 'builtin:cancel', id }).catch(() => {});
  }
}
