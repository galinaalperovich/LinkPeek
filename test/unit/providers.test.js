import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, listModels, streamChat } from '../../src/lib/providers.js';

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with a queue of canned responses and records the calls. */
function mockFetch(...responses) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}

const sse = (events) =>
  new Response(events.map((e) => (typeof e === 'string' ? `data: ${e}\n\n` : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function collect(request) {
  const events = [];
  for await (const event of streamChat(request)) events.push(event);
  return events;
}

const MESSAGES = [
  { role: 'user', parts: [{ type: 'text', text: '<page>…</page>', cache: true }, { type: 'text', text: 'Summarize.' }] },
];
const claude = (extra = {}) => ({
  provider: 'anthropic', apiKey: 'sk-ant-test', baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5', system: 'SYSTEM', messages: MESSAGES, ...extra,
});
const openai = (extra = {}) => ({
  provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-6.2-sol', system: 'SYSTEM', messages: MESSAGES, ...extra,
});

const CLAUDE_STREAM = [
  { type: 'message_start', message: { model: 'claude-opus-5-5' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];

test('Claude: request shape', async () => {
  const calls = mockFetch(sse(CLAUDE_STREAM));
  await collect(claude());
  const [{ url, headers, body }] = calls;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'sk-ant-test');
  assert.equal(headers['anthropic-version'], '2026-10-21');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.system, 'SYSTEM');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.ok(body.max_tokens >= 8000);
  // Parameters current models reject must never be sent.
  for (const banned of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(banned in body), banned);
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: '<page>…</page>', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Summarize.' },
  ]);
});

test('Claude: streams text, ignores thinking, reports the stop reason', async () => {
  mockFetch(sse(CLAUDE_STREAM));
  assert.deepEqual(await collect(claude()), [
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'world' },
    { type: 'done', stopReason: 'end', detail: '', model: 'claude-opus-5-5' },
  ]);
});

test('Claude: models without server-side fallback do not get the parameter', async () => {
  const calls = mockFetch(sse(CLAUDE_STREAM));
  await collect(claude({ model: 'claude-haiku-5-5' }));
  assert.ok(!('fallbacks' in calls[0].body));
  assert.ok(!('anthropic-beta' in calls[0].headers));
  assert.deepEqual(calls[0].body.output_config, { effort: 'low' });
});

test('Claude: a mid-stream fallback discards the declined attempt', async () => {
  mockFetch(sse([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_start', content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'full answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]));
  assert.deepEqual((await collect(claude())).map((e) => e.type === 'text' ? e.text : e.type), ['partial', 'reset', 'full answer', 'done']);
});

test('Claude: a refusal is reported with its category', async () => {
  mockFetch(sse([{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }]));
  assert.deepEqual(await collect(claude()), [{ type: 'done', stopReason: 'refusal', detail: 'cyber', model: '' }]);
});

test('Claude: PDFs go out as document blocks', async () => {
  const calls = mockFetch(sse(CLAUDE_STREAM));
  await collect(claude({ messages: [{ role: 'user', parts: [{ type: 'pdf', data: 'QUJD', name: 'a.pdf' }, { type: 'text', text: 'meta', cache: true }] }] }));
  assert.deepEqual(calls[0].body.messages[0].content[0], {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' },
  });
});

test('Claude: an error event in the stream becomes a ProviderError', async () => {
  mockFetch(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]));
  await assert.rejects(collect(claude()), (err) => err instanceof ProviderError && /overloaded/i.test(err.message));
});

test('a 400 is retried once without the tuning fields', async () => {
  const calls = mockFetch(
    json(400, { error: { type: 'invalid_request_error', message: 'output_config: Extra inputs are not permitted' } }),
    sse(CLAUDE_STREAM),
  );
  const events = await collect(claude({ model: 'claude-haiku-4-5' }));
  assert.equal(calls.length, 2);
  assert.ok(!('output_config' in calls[1].body));
  assert.ok(!('fallbacks' in calls[1].body));
  assert.equal(events.at(-1).type, 'done');
});

test('HTTP errors map to helpful messages', async () => {
  mockFetch(json(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  await assert.rejects(collect(claude()), (err) => err.code === 'auth' && err.status === 401 && err.detail === 'invalid x-api-key');

  mockFetch(json(404, { error: { type: 'not_found_error', message: 'model: nope' } }));
  await assert.rejects(collect(claude({ model: 'nope' })), (err) => err.code === 'model' && err.message.includes('"nope"'));

  mockFetch(json(429, { error: { message: 'slow down' } }));
  await assert.rejects(collect(openai()), (err) => err.code === 'rate-limit');

  mockFetch(new Response('upstream down', { status: 503 }));
  await assert.rejects(collect(openai()), (err) => err.code === 'unavailable');
});

test('a network failure is reported as such; an abort passes through', async () => {
  mockFetch(new TypeError('Failed to fetch'));
  await assert.rejects(collect(openai()), (err) => err instanceof ProviderError && err.code === 'network');

  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  mockFetch(abort);
  await assert.rejects(collect(openai()), (err) => err === abort);
});

test('OpenAI: request shape and stream', async () => {
  const calls = mockFetch(sse([
    JSON.stringify({ model: 'gpt-6.2-sol', choices: [{ delta: { role: 'assistant', content: '' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'Hi ' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'there' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    '[DONE]',
    JSON.stringify({ choices: [{ delta: { content: 'ignored after DONE' } }] }),
  ]));
  const events = await collect(openai());
  const [{ url, headers, body }] = calls;
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers.authorization, 'Bearer sk-test');
  assert.equal(body.stream, true);
  assert.equal(body.reasoning_effort, 'low');
  assert.ok(!('temperature' in body));
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: '<page>…</page>\n\nSummarize.' },
  ]);
  assert.deepEqual(events, [
    { type: 'text', text: 'Hi ' },
    { type: 'text', text: 'there' },
    { type: 'done', stopReason: 'length', detail: '', model: 'gpt-6.2-sol' },
  ]);
});

test('OpenAI: PDFs go out as file parts', async () => {
  const calls = mockFetch(sse(['[DONE]']));
  await collect(openai({ messages: [{ role: 'user', parts: [{ type: 'pdf', data: 'QUJD', name: 'paper.pdf' }, { type: 'text', text: 'meta' }] }] }));
  assert.deepEqual(calls[0].body.messages[1].content, [
    { type: 'file', file: { filename: 'paper.pdf', file_data: 'data:application/pdf;base64,QUJD' } },
    { type: 'text', text: 'meta' },
  ]);
});

test('servers that ignore "stream" and answer with JSON still work', async () => {
  mockFetch(json(200, { model: 'local', choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }] }));
  assert.deepEqual(await collect(openai()), [
    { type: 'text', text: 'whole answer' },
    { type: 'done', stopReason: 'end', detail: '', model: 'local' },
  ]);

  mockFetch(json(200, { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'whole' }] }));
  assert.deepEqual((await collect(claude()))[0], { type: 'text', text: 'whole' });
});

test('listModels', async () => {
  let calls = mockFetch(json(200, { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { nope: true }] }));
  assert.deepEqual(await listModels({ provider: 'anthropic', apiKey: 'k', baseUrl: 'https://api.anthropic.com' }), [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  ]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(calls[0].headers['x-api-key'], 'k');

  calls = mockFetch(json(200, { data: [{ id: 'gpt-6.2-sol' }] }));
  assert.deepEqual(await listModels({ provider: 'openai', apiKey: 'k', baseUrl: 'http://localhost:11434/v1' }), [
    { id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' },
  ]);
  assert.equal(calls[0].url, 'http://localhost:11434/v1/models');
  assert.equal(calls[0].headers.authorization, 'Bearer k');

  mockFetch(json(401, { error: { message: 'bad key' } }));
  await assert.rejects(listModels({ provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1' }), (err) => err.code === 'auth');
});
