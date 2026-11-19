// Local test server: fixture pages plus stand-ins for the Claude and OpenAI
// APIs that speak the real streaming wire formats. Nothing here leaves the
// machine and no real API key is involved.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const SOURDOUGH_SUMMARY = `**TL;DR:** A sourdough starter is a stable culture of wild yeast and lactic acid bacteria that you build in about a week by feeding flour and water on a schedule.

- **Two organisms, one job:** wild yeast makes the gas that raises the loaf; lactic acid bacteria make the acids that give it flavour and keep other microbes out.
- **Timeline:** lively on day 2–3, quiet around day 4–5, reliable by day 7–10.
- **Feeding:** a 1:1:1 ratio of starter, flour and water by weight, once a day at about 24 °C.
- **Ready when:** it doubles within 4–6 hours of a feed.
- **Storage:** once established, it keeps in the fridge on one feed a week.

Worth knowing: the quiet spell around day four is normal. Most people throw their starter out too early.`;

export const SOURDOUGH_ANSWER =
  'About **7 to 10 days** at room temperature (around 24 °C). It is ready when it doubles within 4–6 hours of a feed.';

// "Привет, мир" and a paragraph, encoded as windows-1251.
function legacyPage() {
  const text =
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><title>Старая страница</title></head><body><article><h1>Привет, мир</h1><p>' +
    'Эта страница сохранена в кодировке windows-1251, как множество старых сайтов. '.repeat(8) +
    '</p></article></body></html>';
  const table = new Map();
  const decoder = new TextDecoder('windows-1251');
  for (let byte = 0x80; byte <= 0xff; byte++) table.set(decoder.decode(new Uint8Array([byte])), byte);
  return Buffer.from([...text].map((ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : table.get(ch) ?? 0x3f)));
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

function titleOf(text) {
  return /<title>([^<]*)<\/title>/.exec(text)?.[1] || 'this page';
}

/** Decides what the "model" says, from the provider-neutral view of a request. */
function reply({ pageText, lastUserText, turns }) {
  if (turns > 1) {
    return /sourdough/i.test(pageText) ? SOURDOUGH_ANSWER : `Mock answer to: ${lastUserText}`;
  }
  if (/sourdough/i.test(pageText)) return SOURDOUGH_SUMMARY;
  return `**TL;DR:** Mock summary of "${titleOf(pageText)}".\n\n- First point\n- Second point`;
}

// A rating request is recognised by its system prompt. The "model" knows one source.
const isRatingRequest = (system) => /rate how far a reader can generally trust/.test(String(system));
function ratingReply(source) {
  return /Weekend Reader/.test(source)
    ? '{"level": 4, "reason": "Established food magazine with named authors"}'
    : '{"level": 0, "reason": "Not a source I recognise"}';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function pieces(text, size = 14) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function startServer() {
  /** Every model request the extension made: { api, headers, body }. */
  const requests = [];
  /** Source reputation requests, kept apart from the summaries and answers. */
  const reputationRequests = [];
  const state = { chunkDelay: 6, changes: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    try {
      // ── Claude Messages API ────────────────────────────────────────────
      if (url.pathname === '/anthropic/v1/models') {
        if (req.headers['x-api-key'] === 'sk-ant-bad') {
          return send(401, 'application/json', JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        }
        return send(200, 'application/json', JSON.stringify({
          data: [
            { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
            { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
            { id: 'claude-experimental-1', display_name: 'Claude Experimental' },
          ],
        }));
      }
      if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST') {
        const body = await readJson(req);
        const rating = isRatingRequest(body.system);
        (rating ? reputationRequests : requests).push({ api: 'anthropic', headers: req.headers, body });
        const first = body.messages[0].content;
        const last = body.messages.at(-1).content;
        const pageText = first.map((block) => block.text || '').join('\n');
        const text = rating
          ? ratingReply(pageText)
          : reply({ pageText, lastUserText: last.at(-1).text || '', turns: body.messages.length });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        emit({ type: 'message_start', message: { id: 'msg_test', model: body.model, role: 'assistant', content: [] } });
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
        emit({ type: 'content_block_stop', index: 0 });
        emit({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
        for (const piece of pieces(text)) {
          emit({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } });
          await sleep(state.chunkDelay);
        }
        emit({ type: 'content_block_stop', index: 1 });
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } });
        emit({ type: 'message_stop' });
        return res.end();
      }

      // ── OpenAI Chat Completions ────────────────────────────────────────
      if (url.pathname === '/openai/models') {
        return send(200, 'application/json', JSON.stringify({
          data: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6-luna' }, { id: 'text-embedding-9' }],
        }));
      }
      if (url.pathname === '/openai/chat/completions' && req.method === 'POST') {
        const body = await readJson(req);
        const rating = isRatingRequest(body.messages[0]?.content);
        (rating ? reputationRequests : requests).push({ api: 'openai', headers: req.headers, body });
        const asText = (content) => (typeof content === 'string' ? content : content.map((part) => part.text || '').join('\n'));
        const conversation = body.messages.filter((message) => message.role !== 'system');
        const pageText = asText(conversation[0].content);
        const text = rating
          ? ratingReply(pageText)
          : reply({ pageText, lastUserText: asText(conversation.at(-1).content), turns: conversation.length });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = (choice) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', model: body.model, choices: [choice] })}\n\n`);
        emit({ index: 0, delta: { role: 'assistant', content: '' } });
        for (const piece of pieces(text)) {
          emit({ index: 0, delta: { content: piece } });
          await sleep(state.chunkDelay);
        }
        emit({ index: 0, delta: {}, finish_reason: 'stop' });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // ── Pages ──────────────────────────────────────────────────────────
      if (url.pathname === '/changing.html') {
        // Same address, different content on every request.
        state.changes++;
        return send(200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8">
          <title>Live scoreboard</title></head><body><article><h1>Live scoreboard</h1>
          <p>${'The match is still being played and this page is rewritten after every point. '.repeat(6)}</p>
          <p>Update number ${state.changes}.</p></article></body></html>`);
      }
      if (url.pathname === '/legacy.html') return send(200, 'text/html', legacyPage());
      if (url.pathname === '/paper.pdf') return send(200, 'application/pdf', PDF);
      if (url.pathname === '/notes.txt') {
        return send(200, 'text/plain; charset=utf-8', 'PLAIN_TEXT_NOTES\nBuy flour. Feed the starter. Bake on Sunday.\n');
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (/^[\w-]+\.html$/.test(name)) {
        try {
          return send(200, 'text/html; charset=utf-8', await readFile(path.join(FIXTURES, name)));
        } catch {
          // fall through to 404
        }
      }
      return send(404, 'text/html; charset=utf-8', '<h1>404 Not Found</h1>');
    } catch (err) {
      return send(500, 'text/plain', String(err?.stack || err));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, reputationRequests, state, close: () => new Promise((resolve) => server.close(resolve)) };
}
