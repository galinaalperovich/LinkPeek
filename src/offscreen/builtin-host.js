// Runs Chrome's built-in AI for the service worker, which cannot reach it:
// the API exists in windows only.
//
// Requests arrive from the service worker (chrome.runtime.sendMessage with
// target 'offscreen'):
//   builtin:state   { lang? }         answered with { ok, state, turningOn }
//   builtin:warm                      start loading the model into memory
//   builtin:start   { id, request }   answer; progress comes back as events.
//                                     A request is about a page ({ system, lang,
//                                     page, … }) or a plain prompt ({ system,
//                                     lang, messages }, the source rating).
//   builtin:cancel  { id }
// and one message is accepted from the content script, sent during a real
// click (see turnOn below):
//   builtin:gesture                   switch the model on, download included
// Events go back one at a time and in order (target 'background',
// type 'builtin:event', with the request's id):
//   { type: 'status', stage: 'downloading' | 'waking' | 'thinking', progress? }
//   { type: 'text', text }
//   { type: 'done', stopReason, detail, notice }
//   { type: 'error', code, message, detail }
//   { type: 'alive' }                 every few seconds: silence means trouble

import { answerWith, builtinState, promptWith, sessionOptions, toBuiltinError } from '../lib/builtin-ai.js';

// Waking the model takes 10 to 25 seconds; a session that is already there
// answers at once. So idle sessions are kept for a few minutes after the last
// answer, then let go, which lets Chrome free the model's memory. There are at
// most two: one per system prompt in use (summaries, source ratings).
const WARM_MS = 3 * 60_000;
const WARM_MAX = 2;
const ALIVE_MS = 8000;
const SLOW_START_MS = 1200;

const jobs = new Map(); // request id → AbortController
const warm = new Map(); // "language + system prompt" → Promise<session>, oldest first
let warmTimer = 0;

const release = (ready) => ready.then((session) => session.destroy(), () => {});

// Switching the model on. Chrome starts the model's one-time download (and its
// first use, when the files are already there) only inside a user gesture: a
// request without one is refused. A hidden page never gets a click of its own,
// but Chrome passes a gesture along a message sent during a real click. So the
// content script sends `builtin:gesture` from the reader's own X+click, or
// from the "Turn on Keyless" button in the bubble, and the model is switched
// on here, with no trip to the settings.
let turningOn = null; // a Promise while that is in flight
let progress = null; // 0..1 while Chrome downloads the model
const watchers = new Set(); // answers waiting for the model: () => void

function turnOn() {
  // Asked for on every peek, not only the first: when the model is already
  // there this costs a tenth of a second and wakes it a moment sooner, and it
  // is what brings the model back if Chrome has removed it to free disk space.
  if (turningOn || !globalThis.LanguageModel) return;
  const attempt = globalThis.LanguageModel.create({
    ...sessionOptions(),
    monitor(monitor) {
      monitor.addEventListener('downloadprogress', (event) => {
        const done = Number(event.loaded) / (Number(event.total) || 1);
        if (!(done >= 0)) return;
        progress = Math.min(1, done);
        // Chrome also reports "100%" for a model that was there all along:
        // only a real download is worth interrupting the reader for.
        if (progress < 1) for (const tell of watchers) tell();
      });
    },
  })
    // Refused means there was no gesture after all, or this computer cannot
    // run the model. Whoever is waiting finds out when it asks for a session.
    .then((session) => session.destroy(), () => {})
    .finally(() => {
      if (turningOn === attempt) turningOn = null;
      progress = null;
    });
  turningOn = attempt;
}

function dropWarm(key) {
  for (const [name, ready] of warm) {
    if (key !== undefined && name !== key) continue;
    warm.delete(name);
    release(ready);
  }
}

function keepWarm() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => dropWarm(), WARM_MS);
}

/** The session that holds this system prompt. Answers are made on clones of it. */
function baseSession(system, lang) {
  const key = `${lang}\n${system}`;
  let ready = warm.get(key);
  warm.delete(key); // re-added below, as the most recently used
  if (!ready) {
    ready = globalThis.LanguageModel.create({
      ...sessionOptions(lang),
      initialPrompts: [{ role: 'system', content: system }],
    });
    ready.catch(() => {
      if (warm.get(key) === ready) warm.delete(key); // do not keep a failure around
    });
  }
  warm.set(key, ready);
  while (warm.size > WARM_MAX) dropWarm(warm.keys().next().value);
  keepWarm();
  return ready;
}

async function freshSession(system, lang, signal) {
  for (let attempt = 0; ; attempt++) {
    const base = await baseSession(system, lang);
    try {
      return await base.clone({ signal });
    } catch (err) {
      // A session Chrome has thrown away in the meantime: start over, once.
      if (attempt || signal.aborted || err?.name === 'AbortError') throw err;
      dropWarm(`${lang}\n${system}`);
    }
  }
}

// Events must arrive in the order they were made, so each one waits for the
// one before it. Text that piles up meanwhile travels as a single event.
function createSender(id, onLost) {
  const queue = [];
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const event = queue.shift();
      try {
        const reply = await chrome.runtime.sendMessage({ target: 'background', type: 'builtin:event', id, event });
        if (reply?.ok === false) throw new Error('nobody is waiting for this answer');
      } catch {
        queue.length = 0;
        onLost();
      }
    }
    busy = false;
  }
  return (event) => {
    const last = queue[queue.length - 1];
    if (event.type === 'text' && last?.type === 'text') last.text += event.text;
    else queue.push(event);
    pump();
  };
}

async function start(id, request) {
  const controller = new AbortController();
  jobs.set(id, controller);
  const send = createSender(id, () => controller.abort());
  const alive = setInterval(() => send({ type: 'alive' }), ALIVE_MS);
  const stopped = new Promise((resolve) => {
    controller.signal.addEventListener('abort', resolve, { once: true });
  });
  let session = null;
  try {
    // Say what the wait is for: a download in progress, at once and with its
    // percentage; a model that is merely slow to wake, after a moment.
    const tell = () =>
      send({ type: 'status', stage: progress !== null && progress < 1 ? 'downloading' : 'waking', progress: progress ?? undefined });
    const slow = setTimeout(tell, SLOW_START_MS);
    watchers.add(tell);
    try {
      // The model is being switched on (see turnOn): that comes first.
      if (turningOn) await Promise.race([turningOn, stopped]);
      if (controller.signal.aborted) return;
      session = await freshSession(String(request.system || ''), String(request.lang || 'en'), controller.signal);
    } finally {
      clearTimeout(slow);
      watchers.delete(tell);
    }
    send({ type: 'status', stage: 'thinking' });
    const answer = Array.isArray(request.messages) ? promptWith : answerWith;
    for await (const event of answer(session, { ...request, signal: controller.signal })) send(event);
  } catch (err) {
    if (!controller.signal.aborted) {
      const error = toBuiltinError(err);
      send({ type: 'error', code: error.code, message: error.message, detail: error.detail });
    }
  } finally {
    clearInterval(alive);
    jobs.delete(id);
    session?.destroy();
    keepWarm();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || typeof message.type !== 'string' || !message.type.startsWith('builtin:')) return undefined;
  if (sender.id !== chrome.runtime.id) return undefined;
  if (message.type === 'builtin:gesture') {
    // The one message taken from a content script. It carries no data, and
    // without a real click behind it Chrome refuses to do anything.
    turnOn();
    sendResponse({ ok: true });
    return undefined;
  }
  if (sender.tab) return undefined; // everything else: service worker only

  if (message.type === 'builtin:state') {
    builtinState(globalThis.LanguageModel, message.lang).then((state) =>
      sendResponse({ ok: true, state, turningOn: Boolean(turningOn) }),
    );
    return true; // answered asynchronously
  }
  if (message.type === 'builtin:warm') {
    // Loading the model is the slow part, and it is the same model whatever
    // the prompt. Chrome keeps it loaded for a while after the session goes.
    if (!warm.size && !turningOn) release(globalThis.LanguageModel?.create(sessionOptions()) ?? Promise.reject());
    sendResponse({ ok: true });
  } else if (message.type === 'builtin:start') {
    start(String(message.id), message.request || {});
    sendResponse({ ok: true });
  } else if (message.type === 'builtin:cancel') {
    jobs.get(String(message.id))?.abort();
    sendResponse({ ok: true });
  }
  return undefined;
});
