// Chrome's built-in AI: the model that ships with Chrome (Gemini Nano), used
// through the Prompt API. It runs on the reader's own computer, so it needs no
// key and sends the page to nobody.
//
// The API only exists in windows, not in service workers, so this file is used
// from two extension pages: the hidden offscreen page (which answers for the
// service worker, see offscreen/builtin-host.js) and the settings page (which
// shows the state and starts the one-time model download on a click).
//
// What the model can and cannot do, measured in Chrome 158:
//   - about 9,000 tokens of context, so a long page is cut to its first part
//     (roughly 4,000 to 6,000 words);
//   - Chrome supports it for English, Spanish, Japanese, German and French;
//   - it keeps to a shape it is shown, but follows free-form format
//     instructions loosely, so Keyless summaries have one set shape
//     (see buildBuiltinSystem in prompts.js);
//   - text only: no PDFs.

import { buildMessages } from './prompts.js';

export const BUILTIN_MODEL = 'gemini-nano';
export const BUILTIN_LANGUAGES = ['en', 'es', 'ja', 'de', 'fr'];

// Tokens kept free for the answer itself.
const ANSWER_TOKENS = 1000;
// Below this much room for the page, there is nothing useful to summarize.
const MIN_PAGE_TOKENS = 300;
// The "this page was cut" note that prompts.js adds, plus a safety margin.
const SLACK_TOKENS = 80;

export class BuiltinError extends Error {
  constructor(message, code = 'builtin', detail = '') {
    super(message);
    this.name = 'BuiltinError';
    this.code = code;
    this.detail = detail;
  }
}

/** The language the model should write in for a page in `lang`. */
export function pickLanguage(lang) {
  const base = String(lang || '').trim().toLowerCase().split(/[-_]/)[0];
  return BUILTIN_LANGUAGES.includes(base) ? base : 'en';
}

/** Options shared by availability() and create(): they must agree. */
export function sessionOptions(lang = 'en') {
  const language = pickLanguage(lang);
  return {
    expectedInputs: [{ type: 'text', languages: [...new Set(['en', language])] }],
    expectedOutputs: [{ type: 'text', languages: [language] }],
  };
}

/**
 * Can this browser, on this computer, run the built-in model right now?
 *   'unsupported'   the browser has no such API (not Chrome, or an old one)
 *   'unavailable'   the API is there, but this computer cannot run the model
 *   'downloadable'  ready after a one-time download that needs a click
 *   'downloading'   that download is in progress
 *   'available'     ready
 */
export async function builtinState(api = globalThis.LanguageModel, lang = 'en') {
  if (typeof api?.availability !== 'function' || typeof api?.create !== 'function') return 'unsupported';
  try {
    const state = await api.availability(sessionOptions(lang));
    return ['available', 'downloadable', 'downloading'].includes(state) ? state : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// The API renamed these once (inputQuota → contextWindow and so on). Accept both.
const windowOf = (session) => Number(session.contextWindow ?? session.inputQuota ?? 0);
const usageOf = (session) => Number(session.contextUsage ?? session.inputUsage ?? 0);

async function measure(session, input) {
  const count = session.measureContextUsage || session.measureInputUsage;
  if (typeof count === 'function') return Number(await count.call(session, input));
  // No way to ask: assume short tokens, which errs on the side of fitting.
  const chars = typeof input === 'string' ? input.length : input.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 3);
}

// Prefer to cut at the end of a paragraph or sentence, if one is near the end.
function trimToBoundary(text) {
  const floor = Math.floor(text.length * 0.85);
  const paragraph = text.lastIndexOf('\n\n');
  if (paragraph >= floor) return text.slice(0, paragraph).trimEnd();
  const sentence = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'), text.lastIndexOf('? '), text.lastIndexOf('! '));
  if (sentence >= floor) return text.slice(0, sentence + 1);
  const space = text.lastIndexOf(' ');
  return (space >= floor ? text.slice(0, space) : text).trimEnd();
}

/**
 * Shortens `text` until it measures at most `budget` tokens.
 * @param {(text: string) => Promise<number>} count
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function fitText(text, budget, count) {
  let tokens = await count(text);
  if (tokens <= budget) return { text, truncated: false };
  let cut = text;
  for (let round = 0; round < 6 && tokens > budget && cut; round++) {
    const keep = Math.floor(cut.length * (budget / tokens) * 0.96);
    cut = keep > 0 ? trimToBoundary(cut.slice(0, keep)) : '';
    tokens = cut ? await count(cut) : 0;
  }
  return { text: tokens <= budget ? cut : '', truncated: true };
}

// A small model sometimes wraps its answer in a tag it saw in the prompt
// (<summary>, <format>…). The bubble shows Markdown, not HTML, so a line that is
// nothing but one tag is dropped. Works on a stream: text is held back only
// while a line could still turn out to be such a tag.
const TAG_LINE = /^\s*<\/?[a-z][a-z_-]{0,24}>\s*$/i;
const MAYBE_TAG_LINE = /^\s*(?:<\/?[a-z_-]{0,25}>?\s*)?$/i;

export function createTagFilter() {
  let held = ''; // the start of the current line, not passed on yet
  let open = false; // the current line is already being passed on
  return {
    push(chunk) {
      let out = '';
      for (const ch of String(chunk)) {
        if (open) {
          out += ch;
          if (ch === '\n') open = false;
          continue;
        }
        held += ch;
        if (ch === '\n') {
          if (!TAG_LINE.test(held)) out += held;
          held = '';
        } else if (!MAYBE_TAG_LINE.test(held)) {
          out += held;
          held = '';
          open = true;
        }
      }
      return out;
    },
    flush() {
      const rest = TAG_LINE.test(held) ? '' : held;
      held = '';
      open = false;
      return rest;
    },
  };
}

// Every Keyless summary opens with the same bold label as a summary made with
// a key. The model writes it almost every time; this makes it every time.
const LEAD = '**TL;DR:** ';
const HAS_LEAD = /^[\s*_]*TL;?\s?DR\b/i;

export function createLead() {
  let held = '';
  let done = false;
  const release = () => {
    done = true;
    const text = held.trimStart();
    held = '';
    return text && !HAS_LEAD.test(text) ? LEAD + text : text;
  };
  return {
    push(chunk) {
      if (done) return chunk;
      held += chunk;
      // Enough to tell whether the label is there.
      return held.trimStart().length >= 10 ? release() : '';
    },
    flush: () => (done ? '' : release()),
  };
}

// prompts.js builds provider-neutral messages; the Prompt API wants
// { role, content } with plain text.
// Two messages in a row from the same side are merged into one.
function toPromptInput(messages) {
  const input = [];
  for (const message of messages) {
    const content = message.parts.map((part) => part.text || '').join('\n\n');
    const last = input[input.length - 1];
    if (last?.role === message.role) last.content += `\n\n${content}`;
    else input.push({ role: message.role, content });
  }
  return input;
}

const wordCount = (text) => (text.match(/\S+/g) || []).length;

function roundWords(count) {
  if (count < 1000) return String(Math.max(100, Math.round(count / 100) * 100));
  return (Math.round(count / 100) * 100).toLocaleString('en-US');
}

/**
 * Streams one answer from a session that already holds the system prompt.
 * Fits the page into the model's context first: a long page is cut to its
 * first part (and the reader is told), a long conversation loses its oldest
 * turns.
 *
 * @param {object} session  a LanguageModel session, used for this answer only
 * @param {{ page: object, linkText?: string, history?: object[], question?: string,
 *           signal?: AbortSignal }} request
 * Yields { type: 'text', text } and finally
 *        { type: 'done', stopReason: 'end', detail: '', notice }.
 */
export async function* answerWith(session, { page, linkText = '', history = [], question = '', signal }) {
  if (page.kind === 'pdf') {
    throw new BuiltinError('Keyless cannot read PDFs. Switch to “Your key” in settings to peek at PDFs.', 'builtin-pdf');
  }
  const size = windowOf(session);
  let turns = [...history];
  let fitted = page;
  let notice = '';

  if (size) {
    const room = async () => {
      const empty = toPromptInput(buildMessages({ page: { ...page, text: '' }, linkText, history: turns, question }));
      return size - usageOf(session) - (await measure(session, empty)) - ANSWER_TOKENS - SLACK_TOKENS;
    };
    let budget = await room();
    // A long conversation: forget the oldest question and its answer first,
    // the summary last.
    while (budget < MIN_PAGE_TOKENS && turns.length) {
      const summary = turns[0]?.role === 'assistant';
      turns = summary && turns.length > 2 ? [turns[0], ...turns.slice(3)] : turns.slice(summary ? 1 : 2);
      budget = await room();
    }
    if (budget < MIN_PAGE_TOKENS) {
      throw new BuiltinError("This is too much for Chrome's built-in AI. Try a shorter question.", 'too-large');
    }
    const fit = await fitText(String(page.text || ''), budget, (text) => measure(session, text));
    if (fit.truncated) {
      if (!fit.text) throw new BuiltinError("That page is too large for Chrome's built-in AI.", 'too-large');
      fitted = { ...page, text: fit.text, truncated: true };
      notice = `Long page: Keyless read about the first ${roundWords(wordCount(fit.text))} words. With your own key, LinkPeek reads much longer pages.`;
    }
  }

  const input = toPromptInput(buildMessages({ page: fitted, linkText, history: turns, question }));
  const filter = createTagFilter();
  // A summary, as opposed to an answer to a question, gets its fixed opening.
  const lead = question ? { push: (text) => text, flush: () => '' } : createLead();
  for await (const chunk of session.promptStreaming(input, { signal })) {
    const text = lead.push(filter.push(chunk));
    if (text) yield { type: 'text', text };
  }
  const rest = lead.push(filter.flush()) + lead.flush();
  if (rest) yield { type: 'text', text: rest };
  yield { type: 'done', stopReason: 'end', detail: '', notice };
}

/**
 * A plain prompt for the one small job that is not about a page's text: the
 * source rating. `messages` are in the same shape prompts.js builds.
 * Yields { type: 'text', text } and finally { type: 'done', … }.
 */
export async function* promptWith(session, { messages, signal }) {
  for await (const chunk of session.promptStreaming(toPromptInput(messages), { signal })) {
    if (chunk) yield { type: 'text', text: chunk };
  }
  yield { type: 'done', stopReason: 'end', detail: '', notice: '' };
}

/** Turns whatever the API threw into something the bubble can show. */
export function toBuiltinError(err) {
  if (err instanceof BuiltinError) return err;
  const detail = String(err?.message || err || '');
  switch (err?.name) {
    case 'QuotaExceededError':
      return new BuiltinError("That page is too large for Chrome's built-in AI.", 'too-large', detail);
    case 'NotAllowedError':
      return new BuiltinError("Keyless is not switched on yet. Turn it on in LinkPeek settings.", 'builtin-setup', detail);
    case 'NotSupportedError':
      return new BuiltinError("Chrome's built-in AI cannot handle this page. It may be in a language it does not support.", 'builtin', detail);
    default:
      return new BuiltinError("Chrome's built-in AI stopped with an error.", 'builtin', detail);
  }
}
