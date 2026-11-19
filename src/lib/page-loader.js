// Gets the content behind a link without disturbing the page the reader is on.
//
// 1. Fetch the URL in the background (fast, invisible). HTML is parsed in an
//    offscreen document; PDFs are passed to the model as documents.
// 2. If that yields too little text (a JavaScript app, a bot check), open the
//    link in a muted background tab, read the rendered page, close the tab.

export class LoadError extends Error {
  constructor(message, code = 'load', { fatal = false } = {}) {
    super(message);
    this.name = 'LoadError';
    this.code = code;
    this.fatal = fatal; // true: a background tab would not help either
  }
}

/** Longest page text sent to the model. Longer pages are cut and flagged. */
export const MAX_TEXT_CHARS = 100_000;
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const TAB_LOAD_TIMEOUT_MS = 15_000;
const TAB_LOAD_POLL_MS = 120;
const TAB_POLLS = 8;
const TAB_POLL_MS = 700;
const THIN_CHARS = 400;
const JS_WALL = /enable javascript|javascript is (required|disabled|not enabled)|checking your browser|just a moment|verify(ing)? you are (a )?human|access denied/i;

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const EXTRACT_SCRIPT = 'src/lib/extract.js';
const TEMP_TABS_KEY = 'tempTabs';
const ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

export function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new LoadError('That link is not a valid web address.', 'bad-url', { fatal: true });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LoadError('LinkPeek can only read http and https links.', 'bad-url', { fatal: true });
  }
  return url.href;
}

function fileName(url) {
  try {
    const { pathname, hostname } = new URL(url);
    const last = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    return last || hostname;
  } catch {
    return '';
  }
}

// ── Reading and decoding ─────────────────────────────────────────────────

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let capped = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      capped = true;
      reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = bytes.byteLength - offset;
    if (room <= 0) break;
    bytes.set(room >= chunk.byteLength ? chunk : chunk.subarray(0, room), offset);
    offset += chunk.byteLength;
  }
  return { bytes, capped };
}

// Honour the page's own charset; plenty of the web is still not UTF-8.
export function decodeText(bytes, contentType = '') {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ── HTML parsing via the offscreen document ──────────────────────────────

let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['DOM_PARSER'],
      justification: 'Parse fetched HTML into readable text.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

// A page's inline event handlers (onclick, onerror, onload…) must never exist
// in a document that an extension page parses: the extension's own security
// policy forbids inline handlers, and Chrome reports each one it meets as an
// error against the extension. Renaming the attributes before parsing keeps the
// parsed document free of them. Only attribute names inside tags are touched;
// text between tags is left exactly as it is.
const HTML_TAG = /<[a-zA-Z][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
const HANDLER_ATTRIBUTE = /([\s"'/])on([a-z]+\s*=)/gi;

export function neutralizeHandlers(html) {
  return html.replace(HTML_TAG, (tag) => tag.replace(HANDLER_ATTRIBUTE, '$1data-lp-on$2'));
}

async function parseHtml(html, url) {
  await ensureOffscreen();
  const message = { target: 'offscreen', type: 'extract', url, html: neutralizeHandlers(html) };
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    await sleep(150); // the document was created a moment ago and is still loading
    response = await chrome.runtime.sendMessage(message);
  }
  if (!response?.ok) throw new LoadError('Could not read that page.', 'parse');
  return response.result;
}

// ── Site icons ───────────────────────────────────────────────────────────

const MAX_ICON_BYTES = 400 * 1024;
const ICON_TIMEOUT_MS = 6000;

/**
 * The icon of the site behind a page, as raw pixels: `{ size, rgba }` with
 * `rgba` base64-encoded, or null when the site has no usable icon. Tries the
 * icon the page declares, then the conventional /favicon.ico.
 */
export async function loadIcon(pageUrl, declared, signal) {
  const candidates = [];
  if (declared && /^(https?:|data:image\/)/i.test(declared)) candidates.push(declared);
  try {
    candidates.push(new URL('/favicon.ico', pageUrl).href);
  } catch {
    // no usable page address: only the declared icon is tried
  }
  for (const candidate of new Set(candidates)) {
    try {
      const timeout = AbortSignal.timeout(ICON_TIMEOUT_MS);
      const res = await fetch(candidate, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        credentials: 'omit', // an icon is public; never send the reader's cookies for one
      });
      if (!res.ok) continue;
      const { bytes, capped } = await readCapped(res, MAX_ICON_BYTES);
      if (capped || bytes.byteLength < 30) continue;
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 300)).trimStart().toLowerCase();
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const svg = type === 'image/svg+xml' || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
      if (!svg && head.startsWith('<')) continue; // an HTML "not found" page, not an image
      await ensureOffscreen();
      // Decoding is quick; the timeout only guards against an answer that never comes.
      const response = await Promise.race([
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'icon',
          bytes: toBase64(bytes),
          mime: svg ? 'image/svg+xml' : type.startsWith('image/') ? type : 'image/x-icon',
        }),
        sleep(ICON_TIMEOUT_MS).then(() => null),
      ]);
      if (response?.ok) return response.result;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  return null;
}

// ── PDFs ─────────────────────────────────────────────────────────────────

const pdfCache = new Map(); // url → { data, name }, small and short-lived

function rememberPdf(url, pdf) {
  pdfCache.delete(url);
  pdfCache.set(url, pdf);
  while (pdfCache.size > 2) pdfCache.delete(pdfCache.keys().next().value);
}

async function readPdf(res, url) {
  const megabytes = Math.round(MAX_PDF_BYTES / 1024 / 1024);
  const tooLarge = () =>
    new LoadError(`That PDF is larger than ${megabytes} MB, too big to send to the model.`, 'too-large', {
      fatal: true,
    });
  if (Number(res.headers.get('content-length')) > MAX_PDF_BYTES) {
    res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const { bytes, capped } = await readCapped(res, MAX_PDF_BYTES);
  if (capped) throw tooLarge();
  const pdf = { data: toBase64(bytes), name: fileName(url) || 'document.pdf' };
  rememberPdf(url, pdf);
  return { kind: 'pdf', via: 'fetch', url, title: pdf.name, text: '', sizeBytes: bytes.byteLength, pdf };
}

/** The PDF behind a page that was loaded earlier (follow-up questions). */
export async function getPdf(url, signal) {
  const cached = pdfCache.get(url);
  if (cached) return cached;
  const page = await fetchDirect(normalizeUrl(url), signal);
  if (page.kind !== 'pdf') throw new LoadError('That link no longer returns a PDF.', 'load');
  return page.pdf;
}

// ── Step 1: background fetch ─────────────────────────────────────────────

async function fetchDirect(url, signal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(url, {
      signal: combined,
      credentials: 'include', // same session the reader would have in a tab
      redirect: 'follow',
      headers: { accept: ACCEPT },
    });
    const finalUrl = res.url || url;

    if (res.status === 404 || res.status === 410) {
      res.body?.cancel().catch(() => {});
      throw new LoadError(`That page does not exist (HTTP ${res.status}).`, 'not-found', { fatal: true });
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new LoadError(`The site answered with HTTP ${res.status}.`, 'http');
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const mime = contentType.split(';')[0].trim();
    const pdfByName = /\.pdf$/i.test(new URL(finalUrl).pathname);
    if (mime === 'application/pdf' || ((!mime || mime === 'application/octet-stream') && pdfByName)) {
      return await readPdf(res, finalUrl);
    }
    if (/^(image|audio|video|font)\//.test(mime) || /octet-stream|zip|x-tar|msword|officedocument|x-msdownload/.test(mime)) {
      res.body?.cancel().catch(() => {});
      const kind = /^(image|audio|video)\//.test(mime) ? mime.split('/')[0] : 'binary';
      throw new LoadError(`That link points to ${kind === 'binary' ? 'a file' : `${kind === 'image' ? 'an' : 'a'} ${kind} file`}, not a page LinkPeek can read.`, 'unsupported', {
        fatal: true,
      });
    }

    const { bytes } = await readCapped(res, MAX_HTML_BYTES);
    const text = decodeText(bytes, contentType);
    const isHtml =
      mime === 'text/html' ||
      mime === 'application/xhtml+xml' ||
      (!mime && /^\s*<(!doctype|html)/i.test(text.slice(0, 300)));
    if (isHtml) return { kind: 'html', via: 'fetch', url: finalUrl, ...(await parseHtml(text, finalUrl)) };

    // Plain text, Markdown, JSON, CSV, XML…
    return { kind: 'text', via: 'fetch', url: finalUrl, title: fileName(finalUrl), text: text.trim() };
  } catch (err) {
    if (err instanceof LoadError || signal?.aborted) throw err;
    throw new LoadError(
      timeout.aborted ? 'That page took too long to respond.' : 'Could not reach that page.',
      'network',
    );
  }
}

// ── Step 2: background tab ───────────────────────────────────────────────

let tempTabsQueue = Promise.resolve();

function updateTempTabs(change) {
  tempTabsQueue = tempTabsQueue
    .then(async () => {
      const { [TEMP_TABS_KEY]: ids = [] } = await chrome.storage.session.get(TEMP_TABS_KEY);
      await chrome.storage.session.set({ [TEMP_TABS_KEY]: change(ids) });
    })
    .catch(() => {});
  return tempTabsQueue;
}

/** Closes tabs a previous service worker left behind. Call once at startup. */
export async function cleanupTempTabs() {
  const { [TEMP_TABS_KEY]: stale = [] } = await chrome.storage.session.get(TEMP_TABS_KEY);
  if (!stale.length) return;
  await Promise.allSettled(stale.map((id) => chrome.tabs.remove(id)));
  await updateTempTabs((ids) => ids.filter((id) => !stale.includes(id)));
}

// Polls instead of listening for tabs.onUpdated: a local or cached page can
// finish loading within milliseconds of tabs.create() resolving, and Chrome
// does not reliably deliver the "complete" event to a listener added that late.
async function waitForLoad(tabId, signal) {
  const deadline = Date.now() + TAB_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new LoadError('The background tab was closed.', 'load');
    }
    if (tab.status === 'complete' && tab.url && !tab.url.startsWith('about:')) return;
    await sleep(TAB_LOAD_POLL_MS, signal);
  }
  // A page that never finishes loading may still have its text by now.
}

async function extractInTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [EXTRACT_SCRIPT] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        ...globalThis.LinkPeekExtract.extract(document, { live: true, url: location.href }),
      }),
    });
    return injection?.result || null;
  } catch {
    return null; // an error page, or a URL extensions may not script
  }
}

async function extractViaTab(url, { signal, windowId }) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false, ...(windowId ? { windowId } : {}) });
  } catch {
    // The reader's window cannot hold tabs (an installed web app, a popup).
    tab = await chrome.tabs.create({ url, active: false });
  }
  await updateTempTabs((ids) => [...ids, tab.id]);
  try {
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    await waitForLoad(tab.id, signal);
    let best = null;
    let previous = -1;
    for (let attempt = 0; attempt < TAB_POLLS; attempt++) {
      const result = await extractInTab(tab.id);
      const chars = result?.text.length ?? 0;
      if (result && chars >= (best?.text.length ?? 0)) best = result;
      // Client-rendered pages fill in over time: stop once the text settles.
      if (chars >= THIN_CHARS && chars === previous) break;
      previous = chars;
      await sleep(TAB_POLL_MS, signal);
    }
    return best ? { kind: 'html', via: 'tab', ...best } : null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
    updateTempTabs((ids) => ids.filter((id) => id !== tab.id));
  }
}

// ── Putting it together ──────────────────────────────────────────────────

function looksThin(page) {
  const text = page.text || '';
  return text.length < THIN_CHARS || (text.length < 1500 && JS_WALL.test(text));
}

function finalize(page) {
  let text = page.text || '';
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    const cut = text.lastIndexOf('\n', MAX_TEXT_CHARS);
    text = text.slice(0, cut > MAX_TEXT_CHARS * 0.8 ? cut : MAX_TEXT_CHARS).trimEnd();
    truncated = true;
  }
  return { ...page, title: page.title || fileName(page.url), text, truncated };
}

/**
 * @param {string} rawUrl
 * @param {{ signal?: AbortSignal, onStatus?: (stage: string) => void, windowId?: number }} [options]
 * @returns {Promise<object>} `{ kind: 'html' | 'text' | 'pdf', url, title, text, truncated, … }`
 */
export async function loadPage(rawUrl, { signal, onStatus = () => {}, windowId } = {}) {
  const url = normalizeUrl(rawUrl);

  onStatus('fetching');
  let direct = null;
  let failure = null;
  try {
    direct = await fetchDirect(url, signal);
  } catch (err) {
    if (signal?.aborted || err.fatal) throw err;
    failure = err;
  }
  if (direct && (direct.kind !== 'html' || !looksThin(direct))) return finalize(direct);

  onStatus('rendering');
  let rendered = null;
  try {
    rendered = await extractViaTab(url, { signal, windowId });
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  const candidates = [rendered, direct].filter(Boolean);
  const best = candidates.sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0))[0];
  if (best && (best.text || '').trim().length >= 20) return finalize(best);
  // No body text, but a title and description still say what the page is.
  const described = candidates.find((page) => page.description);
  if (described) return finalize({ ...described, text: described.description });
  throw failure || new LoadError('Could not find any readable text on that page.', 'empty');
}
