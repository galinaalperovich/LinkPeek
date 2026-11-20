import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_LANGUAGES,
  BuiltinError,
  answerWith,
  builtinState,
  createLead,
  createTagFilter,
  fitText,
  pickLanguage,
  promptWith,
  sessionOptions,
  toBuiltinError,
} from '../../src/lib/builtin-ai.js';
import { buildBuiltinSystem } from '../../src/lib/prompts.js';
import { PROVIDERS, engineLabel, resolveKeyProvider, resolveMode, resolveModel, resolveProvider } from '../../src/lib/settings.js';

// A stand-in for a Prompt API session: one token per word, a fixed window.
function fakeSession({ window = 9216, used = 20, reply = ['**TL;DR:** fine.', '\n- one', '\n- two'], legacy = false } = {}) {
  const count = (input) =>
    (typeof input === 'string' ? input : input.map((message) => message.content).join(' ')).split(/\s+/).filter(Boolean).length;
  const session = {
    prompts: [],
    async *promptStreaming(input, options) {
      session.prompts.push({ input, options });
      for (const piece of reply) yield piece;
    },
  };
  if (legacy) Object.assign(session, { inputQuota: window, inputUsage: used, measureInputUsage: async (input) => count(input) });
  else Object.assign(session, { contextWindow: window, contextUsage: used, measureContextUsage: async (input) => count(input) });
  return session;
}

const PAGE = { kind: 'html', url: 'https://example.com/a', title: 'A', text: 'Short page text.', lang: 'en', truncated: false };
const collect = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};
const textOf = (events) => events.filter((event) => event.type === 'text').map((event) => event.text).join('');
const words = (count) => Array.from({ length: count }, (_, i) => `word${i}.`).join(' ');

test('the reader chooses: Keyless or Your key, and a saved key never overrides the choice', () => {
  const base = { apiKey: '', mode: '', provider: 'auto', models: { anthropic: '', openai: '' }, baseUrl: '' };
  // Keyless means Chrome's built-in AI, with or without a key in storage.
  assert.equal(resolveProvider({ ...base, mode: 'keyless' }), 'builtin');
  assert.equal(resolveProvider({ ...base, mode: 'keyless', apiKey: 'sk-ant-x' }), 'builtin');
  assert.equal(resolveModel({ ...base, mode: 'keyless' }), PROVIDERS.builtin.defaultModel);
  // Your key means the key's provider, and never falls back to Keyless.
  assert.equal(resolveProvider({ ...base, mode: 'key', apiKey: 'sk-ant-x' }), 'anthropic');
  assert.equal(resolveProvider({ ...base, mode: 'key', apiKey: 'sk-x' }), 'openai');
  assert.equal(resolveProvider({ ...base, mode: 'key' }), 'anthropic');
  assert.equal(resolveProvider({ ...base, mode: 'key', apiKey: 'sk-ant-x', provider: 'openai' }), 'openai');
  // The provider the key belongs to is the same whatever the mode.
  assert.equal(resolveKeyProvider({ ...base, mode: 'keyless', apiKey: 'sk-x' }), 'openai');
});

test('before anything is chosen: a saved key means Your key, no key means Keyless', () => {
  const base = { apiKey: '', mode: '', provider: 'auto', models: { anthropic: '', openai: '' }, baseUrl: '' };
  assert.equal(resolveMode(base), 'keyless');
  assert.equal(resolveMode({ ...base, apiKey: 'sk-ant-x' }), 'key');
  assert.equal(resolveMode({ ...base, mode: 'nonsense' }), 'keyless');
  assert.equal(resolveMode({ ...base, mode: 'key' }), 'key');
  assert.equal(resolveMode({ ...base, mode: 'keyless', apiKey: 'sk-ant-x' }), 'keyless');
});

test('the footer says who answered: this device, the provider, or the server a custom address points to', () => {
  assert.equal(engineLabel('builtin', { baseUrl: '' }), 'AI running on this device');
  assert.equal(engineLabel('anthropic', { baseUrl: '' }), 'AI provided by Anthropic');
  assert.equal(engineLabel('openai', { baseUrl: '' }), 'AI provided by OpenAI');
  assert.equal(engineLabel('openai', { baseUrl: 'https://openrouter.ai/api/v1' }), 'AI provided by openrouter.ai');
  assert.equal(engineLabel('openai', { baseUrl: 'http://localhost:11434/v1' }), 'AI provided by localhost:11434');
  assert.equal(engineLabel('anthropic', { baseUrl: 'not an address' }), 'AI provided by Anthropic');
  assert.equal(engineLabel('builtin', { baseUrl: 'https://openrouter.ai/api/v1' }), 'AI running on this device', 'a saved address is not used by Keyless');
});

test('the model writes in the page language when it can, in English otherwise', () => {
  assert.deepEqual(BUILTIN_LANGUAGES, ['en', 'es', 'ja', 'de', 'fr']);
  assert.equal(pickLanguage('es-MX'), 'es');
  assert.equal(pickLanguage('JA'), 'ja');
  assert.equal(pickLanguage('ru'), 'en');
  assert.equal(pickLanguage(''), 'en');
  assert.deepEqual(sessionOptions('de'), {
    expectedInputs: [{ type: 'text', languages: ['en', 'de'] }],
    expectedOutputs: [{ type: 'text', languages: ['de'] }],
  });
  assert.deepEqual(sessionOptions('ru').expectedOutputs, [{ type: 'text', languages: ['en'] }]);
});

test('state: no API, an API that says no, and the three usable answers', async () => {
  assert.equal(await builtinState(undefined), 'unsupported');
  assert.equal(await builtinState({ availability: async () => 'available' }), 'unsupported'); // no create()
  const api = (answer) => ({ create: async () => ({}), availability: async () => answer });
  for (const state of ['available', 'downloadable', 'downloading']) assert.equal(await builtinState(api(state)), state);
  assert.equal(await builtinState(api('unavailable')), 'unavailable');
  assert.equal(await builtinState(api('something new')), 'unavailable');
  const broken = { create: async () => ({}), availability: async () => { throw new Error('boom'); } };
  assert.equal(await builtinState(broken), 'unavailable');
});

test('state is asked with the same options a session is created with', async () => {
  let seen;
  await builtinState({ create: async () => ({}), availability: async (options) => { seen = options; return 'available'; } }, 'fr');
  assert.deepEqual(seen, sessionOptions('fr'));
});

test('the Keyless prompt shows one set shape, names the language, and has no tags to copy', () => {
  const system = buildBuiltinSystem('es-MX');
  assert.ok(system.includes('**TL;DR:** one sentence'), 'the shape is shown, not described');
  assert.ok(system.includes('- 4 to 6 bullets'));
  assert.ok(system.includes('Write in Spanish.'));
  assert.ok(!/<[a-z]/i.test(system), 'no tag-like text in the prompt');
  // A language Chrome does not list: follow the page, as with a key.
  assert.ok(buildBuiltinSystem('ru').includes('Write in the language of the page.'));
  assert.ok(buildBuiltinSystem().includes('Write in the language of the page.'));
});

test('every Keyless summary opens with the TL;DR label, whether or not the model wrote it', () => {
  const run = (...chunks) => {
    const lead = createLead();
    return chunks.map((chunk) => lead.push(chunk)).join('') + lead.flush();
  };
  assert.equal(run('**TL;DR:** Fine.', '\n- a'), '**TL;DR:** Fine.\n- a');
  assert.equal(run('**TL', ';DR:** Fine.'), '**TL;DR:** Fine.', 'the label arriving in pieces is recognised');
  assert.equal(run('TL;DR: plain label'), 'TL;DR: plain label');
  assert.equal(run('\n **tl;dr** lower case'), '**tl;dr** lower case');
  assert.equal(run('Passkeys replace ', 'passwords.\n- a'), '**TL;DR:** Passkeys replace passwords.\n- a', 'a missing label is added');
  assert.equal(run('Short.'), '**TL;DR:** Short.', 'also when the whole reply is tiny');
  assert.equal(run(''), '', 'nothing in, nothing out');
});

test('fitText: text that fits is untouched', async () => {
  const count = async (text) => text.split(/\s+/).filter(Boolean).length;
  assert.deepEqual(await fitText('a b c', 10, count), { text: 'a b c', truncated: false });
});

test('fitText: text that does not fit is cut to the budget, at a sentence end', async () => {
  const count = async (text) => text.split(/\s+/).filter(Boolean).length;
  const fit = await fitText(words(1000), 200, count);
  assert.equal(fit.truncated, true);
  const kept = await count(fit.text);
  assert.ok(kept <= 200 && kept > 150, `kept ${kept} words`);
  assert.ok(fit.text.endsWith('.'), 'ends at a sentence');
  assert.ok(words(1000).startsWith(fit.text), 'the beginning is what is kept');
});

test('fitText: gives up with empty text when nothing can fit', async () => {
  assert.deepEqual(await fitText('abc def', 0, async (text) => text.length), { text: '', truncated: true });
});

test('tag filter: a line that is only a tag is dropped, also when it arrives in pieces', () => {
  const run = (...chunks) => {
    const filter = createTagFilter();
    return chunks.map((chunk) => filter.push(chunk)).join('') + filter.flush();
  };
  assert.equal(run('<format>\n**TL;DR:** hi\n- a\n</format>'), '**TL;DR:** hi\n- a\n');
  assert.equal(run('<for', 'mat>', '\nHello ', 'world\n</sum', 'mary>\n'), 'Hello world\n');
  assert.equal(run('  </format>  '), '');
});

test('tag filter: everything else passes through unchanged and without delay', () => {
  const filter = createTagFilter();
  assert.equal(filter.push('Hello'), 'Hello');
  assert.equal(filter.push(' <b>bold</b>\n'), ' <b>bold</b>\n');
  assert.equal(filter.push('a < b and c > d\n'), 'a < b and c > d\n');
  assert.equal(filter.push('<3 pasta\n'), '<3 pasta\n');
  assert.equal(filter.push('<b>bold</b> first\n'), '<b>bold</b> first\n');
  assert.equal(filter.push('\n\n- item'), '\n\n- item');
  assert.equal(filter.flush(), '');
  // Held back only while the line could still be a lone tag.
  assert.equal(filter.push('\n<not a tag'), '\n<not a tag');
});

test('a short page: one prompt with the page and the request, the answer streamed', async () => {
  const session = fakeSession();
  const events = await collect(answerWith(session, { page: PAGE, linkText: 'read me' }));
  assert.equal(textOf(events), '**TL;DR:** fine.\n- one\n- two');
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'end', detail: '', notice: '' });
  const [{ input }] = session.prompts;
  assert.equal(input.length, 1);
  assert.equal(input[0].role, 'user');
  assert.ok(input[0].content.includes('Short page text.'));
  assert.ok(input[0].content.includes('<link_text>read me</link_text>'));
  assert.ok(input[0].content.includes('Summarize this page'));
});

test('a long page is cut to fit the window, and the reader is told how much was read', async () => {
  const session = fakeSession({ window: 3000 });
  const events = await collect(answerWith(session, { page: { ...PAGE, text: words(10_000) } }));
  const { content } = session.prompts[0].input[0];
  const sent = content.split(/\s+/).length;
  assert.ok(sent < 3000 - 1000, `prompt of ${sent} words leaves room for the answer`);
  assert.ok(sent > 1500, 'and still uses most of the window');
  assert.ok(content.includes('Only its first part is included'), 'the model is told the page was cut');
  assert.match(events.at(-1).notice, /^Long page: Keyless read about the first 1,[0-9]00 words\./);
});

test('the older names of the same API work too', async () => {
  const session = fakeSession({ window: 3000, legacy: true });
  const events = await collect(answerWith(session, { page: { ...PAGE, text: words(10_000) } }));
  assert.ok(events.at(-1).notice.startsWith('Long page'));
});

test('a follow-up question: the conversation is sent in order, roles alternating', async () => {
  const session = fakeSession({ reply: ['Yes.'] });
  const history = [{ role: 'assistant', text: 'The summary.' }, { role: 'user', text: 'Q1?' }, { role: 'assistant', text: 'A1.' }];
  await collect(answerWith(session, { page: PAGE, history, question: 'Q2?' }));
  assert.deepEqual(session.prompts[0].input.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(session.prompts[0].input.at(-1).content, 'Q2?');
});

test('a question with no summary yet: two user messages become one', async () => {
  const session = fakeSession({ reply: ['It is a page.'] });
  await collect(answerWith(session, { page: PAGE, question: 'What is this?' }));
  const { input } = session.prompts[0];
  assert.equal(input.length, 1);
  assert.ok(input[0].content.endsWith('What is this?'));
});

test('a long conversation forgets its oldest questions before it touches the page', async () => {
  const session = fakeSession({ window: 2200 });
  const history = [{ role: 'assistant', text: 'Summary.' }];
  for (let i = 1; i <= 6; i++) history.push({ role: 'user', text: `Q${i} ${words(150)}` }, { role: 'assistant', text: `A${i}` });
  await collect(answerWith(session, { page: PAGE, history, question: 'Last?' }));
  const { input } = session.prompts[0];
  const all = input.map((m) => m.content).join('\n');
  assert.ok(all.includes('Short page text.'), 'the page is still there');
  assert.ok(all.includes('Summary.'), 'so is the summary');
  assert.ok(!all.includes('Q1 '), 'the oldest question is gone');
  assert.ok(all.includes('Q6 '), 'the newest is kept');
  assert.equal(input.at(-1).content, 'Last?');
});

test('a question too long for the model is refused clearly', async () => {
  const session = fakeSession({ window: 1500 });
  await assert.rejects(
    collect(answerWith(session, { page: PAGE, question: words(800) })),
    (err) => err instanceof BuiltinError && err.code === 'too-large',
  );
});

test('PDFs are refused with a way forward', async () => {
  await assert.rejects(
    collect(answerWith(fakeSession(), { page: { ...PAGE, kind: 'pdf' } })),
    (err) => err.code === 'builtin-pdf' && /Your key/.test(err.message),
  );
});

test('the abort signal reaches the model', async () => {
  const session = fakeSession();
  const { signal } = new AbortController();
  await collect(answerWith(session, { page: PAGE, signal }));
  assert.equal(session.prompts[0].options.signal, signal);
});

test("the model's own tags never reach the bubble", async () => {
  const session = fakeSession({ reply: ['<sum', 'mary>\n', '**Hi**\n', '</summary>'] });
  assert.equal(textOf(await collect(answerWith(session, { page: PAGE }))), '**TL;DR:** **Hi**\n');
});

test('an answer to a question is passed on as it is: the label is for summaries', async () => {
  const session = fakeSession({ reply: ['About 24 ', 'degrees.'] });
  const events = await collect(answerWith(session, { page: PAGE, history: [{ role: 'assistant', text: 'S.' }], question: 'How warm?' }));
  assert.equal(textOf(events), 'About 24 degrees.');
});

test('a plain prompt (the source rating) goes to the model as it is, and comes back as it is', async () => {
  const session = fakeSession({ reply: ['{"level": 4, ', '"reason": "Established outlet"}'] });
  const { signal } = new AbortController();
  const messages = [{ role: 'user', parts: [{ type: 'text', text: '<source>\n<address>example.com</address>\n</source>' }] }];
  const events = await collect(promptWith(session, { messages, signal }));
  assert.equal(textOf(events), '{"level": 4, "reason": "Established outlet"}', 'no TL;DR label, no filtering');
  assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(session.prompts[0].input, [{ role: 'user', content: '<source>\n<address>example.com</address>\n</source>' }]);
  assert.equal(session.prompts[0].options.signal, signal);
});

test("Chrome's errors become messages a reader can act on", () => {
  const named = (name, message = 'raw') => Object.assign(new Error(message), { name });
  assert.equal(toBuiltinError(named('QuotaExceededError')).code, 'too-large');
  assert.equal(toBuiltinError(named('NotAllowedError')).code, 'builtin-setup');
  assert.equal(toBuiltinError(named('NotSupportedError')).code, 'builtin');
  const other = toBuiltinError(named('UnknownError', 'Other generic failures occurred.'));
  assert.equal(other.code, 'builtin');
  assert.equal(other.detail, 'Other generic failures occurred.');
  const own = new BuiltinError('x', 'builtin-pdf');
  assert.equal(toBuiltinError(own), own);
});
