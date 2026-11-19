// LinkPeek service worker.
//
// The content script opens a port per request and sends one message:
//   { type: 'summarize', url, linkText }
//   { type: 'ask', page, linkText, history, question }
//   { type: 'reputation', page }     answered with { type: 'reputation', rating }
// and gets back, in order:
//   { type: 'status', stage }        'fetching' | 'rendering' | 'thinking'
//   { type: 'page', page }           summarize only: what was read
//   { type: 'delta', text }          a piece of the answer
//   { type: 'reset' }                drop the answer so far, a new one follows
//   { type: 'done', stopReason, detail }  or  { type: 'error', code, message, detail }
// Closing the port cancels everything, including a background tab in flight.

import { loadSettings, resolveBaseUrl, resolveModel, resolveProvider } from './lib/settings.js';
import { LoadError, cleanupTempTabs, getPdf, loadPage } from './lib/page-loader.js';
import { ProviderError, streamChat } from './lib/providers.js';
import { buildMessages, buildSystem } from './lib/prompts.js';
import { isRateable, rateSource, sourceKey } from './lib/reputation.js';

const PORT_NAME = 'linkpeek';
const MENU_ID = 'linkpeek-peek';
const MAX_QUESTION_CHARS = 4000;
const RATINGS_KEY = 'ratings'; // chrome.storage.session: forgotten when the browser closes
const MAX_RATINGS = 300;

cleanupTempTabs().catch(() => {});

// ── Install: context menu, live tabs, first-run settings ─────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: 'Peek at this link', contexts: ['link'] });
  await injectIntoOpenTabs();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// Tabs that were already open do not have the content script yet. Inject it so
// LinkPeek works right away, without asking anyone to reload their tabs.
async function injectIntoOpenTabs() {
  const files = chrome.runtime.getManifest().content_scripts[0].js;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id && !tab.discarded && tab.status !== 'unloaded')
      .map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files })),
  );
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.linkUrl) return;
  chrome.tabs
    .sendMessage(tab.id, { type: 'linkpeek:open', url: info.linkUrl }, { frameId: 0 })
    .catch(() => {}); // no content script there (a restricted page)
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'linkpeek:open-options') chrome.runtime.openOptionsPage();
});

// ── Requests ─────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) return;

  const controller = new AbortController();
  let started = false;
  const post = (message) => {
    try {
      port.postMessage(message);
    } catch {
      // The bubble was closed; the abort below stops the work.
    }
  };

  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener(async (message) => {
    if (started) return; // one request per port
    started = true;
    // A model that thinks before answering can be silent for a while. Poke an
    // extension API so Chrome does not put the worker to sleep meanwhile.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
    try {
      await handle(message, { post, signal: controller.signal, windowId: port.sender?.tab?.windowId });
    } catch (err) {
      if (!controller.signal.aborted) post(toErrorMessage(err));
    } finally {
      clearInterval(keepAlive);
    }
  });
});

async function handle(message, { post, signal, windowId }) {
  if (message?.type === 'reputation') return handleReputation(message, { post, signal });
  if (message?.type !== 'summarize' && message?.type !== 'ask') return;

  const settings = await loadSettings();
  if (!settings.apiKey) {
    post({ type: 'error', code: 'no-key', message: 'Add your Claude or OpenAI API key to start peeking.' });
    return;
  }
  const linkText = String(message.linkText || '').slice(0, 300);

  let page;
  let history = [];
  let question = '';
  if (message.type === 'summarize') {
    page = await loadPage(message.url, {
      signal,
      windowId,
      onStatus: (stage) => post({ type: 'status', stage }),
    });
    const { pdf, ...publicPage } = page; // the PDF bytes stay in the worker
    post({ type: 'page', page: publicPage });
  } else {
    page = sanitizePage(message.page);
    question = String(message.question || '').trim().slice(0, MAX_QUESTION_CHARS);
    history = Array.isArray(message.history) ? message.history : [];
    if (!page || !question) throw new LoadError('Nothing to ask about yet.', 'bad-request');
    if (page.kind === 'pdf') page.pdf = await getPdf(page.url, signal);
  }

  post({ type: 'status', stage: 'thinking' });
  const provider = resolveProvider(settings);
  const stream = streamChat({
    provider,
    apiKey: settings.apiKey,
    baseUrl: resolveBaseUrl(settings, provider),
    model: resolveModel(settings, provider),
    system: buildSystem(settings.format),
    messages: buildMessages({ page, linkText, history, question }),
    signal,
  });
  for await (const event of stream) {
    if (event.type === 'text') post({ type: 'delta', text: event.text });
    else if (event.type === 'reset') post({ type: 'reset' });
    else if (event.type === 'done') post({ type: 'done', stopReason: event.stopReason, detail: event.detail });
  }
}

// The reputation meter is an extra, never an error: when no rating can be had
// (feature off, no key, a source nobody could know, a failed request) the
// answer is `rating: null` and the bubble simply shows no meter.
async function handleReputation(message, { post, signal }) {
  let rating = null;
  try {
    const settings = await loadSettings();
    const page = sanitizePage(message.page);
    if (settings.apiKey && settings.reputation && page && isRateable(page)) {
      const provider = resolveProvider(settings);
      const model = resolveModel(settings, provider);
      // One request per source, not per page: ratings are reused for the session.
      const key = `${provider}|${model}|${sourceKey(page)}`;
      const { [RATINGS_KEY]: ratings = {} } = await chrome.storage.session.get(RATINGS_KEY);
      rating = ratings[key] || null;
      if (!rating) {
        rating = await rateSource({
          page,
          provider,
          model,
          apiKey: settings.apiKey,
          baseUrl: resolveBaseUrl(settings, provider),
          signal,
        });
        if (rating) {
          const entries = Object.entries({ ...ratings, [key]: rating }).slice(-MAX_RATINGS);
          await chrome.storage.session.set({ [RATINGS_KEY]: Object.fromEntries(entries) });
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) console.warn('[LinkPeek] reputation', err);
  }
  post({ type: 'reputation', rating });
}

// The page comes back from the content script on follow-up questions. Keep
// only the fields the prompt uses, as plain strings.
function sanitizePage(page) {
  if (!page || typeof page !== 'object' || typeof page.url !== 'string') return null;
  const text = (value, max) => String(value ?? '').slice(0, max);
  return {
    kind: page.kind === 'pdf' ? 'pdf' : 'html',
    url: text(page.url, 4000),
    title: text(page.title, 300),
    siteName: text(page.siteName, 120),
    byline: text(page.byline, 200),
    published: text(page.published, 60),
    description: text(page.description, 1000),
    text: text(page.text, 200_000),
    truncated: Boolean(page.truncated),
  };
}

function toErrorMessage(err) {
  if (err instanceof ProviderError || err instanceof LoadError) {
    return { type: 'error', code: err.code, message: err.message, detail: err.detail || '' };
  }
  console.error('[LinkPeek]', err);
  return {
    type: 'error',
    code: 'unexpected',
    message: 'Something went wrong inside LinkPeek.',
    detail: String(err?.message || err),
  };
}
