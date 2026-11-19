// Local test server: fixture pages plus stand-ins for the Claude and OpenAI
// APIs that speak the real streaming wire formats. Nothing here leaves the
// machine and no real API key is involved.

import http from 'node:http';
import zlib from 'node:zlib';
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

// Replies for the tech article that the screenshots are taken with.
export const PASSKEYS_SUMMARY = `**TL;DR:** A passkey replaces your password with a key pair. The private key never leaves your device, so there is nothing for a fake site or a breached server to steal.

- **Signing in:** the site sends a random challenge, your device signs it with the private key, and the site checks the signature with the public key it stored.
- **Why phishing fails:** a passkey is tied to the real site's exact domain, so a look-alike address gets nothing.
- **What you do:** unlock with a fingerprint, your face or a PIN. That check stays on the device.
- **More than one device:** Apple, Google and password managers sync passkeys with end-to-end encryption.
- **Breaches matter less:** servers hold only public keys, which are useless to an attacker.

Worth knowing: moving passkeys between ecosystems is still clumsy, so keep a second way to sign in on important accounts.`;

export const PASSKEYS_ANSWER =
  'If your passkeys are synced, **nothing is lost**: sign in to your Apple, Google or password-manager account on a new device and they come back. A passkey that lived only on that phone is gone, so use the account\'s recovery method or your second sign-in option.';

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

// A solid-colour PNG, built by hand so the fixtures need no image files.
function png(size, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([r, g, b]))]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The colour of the test site's icon, to recognise it in the bubble. */
export const ICON_COLOR = [36, 99, 235];
const ICON_PNG = png(32, ICON_COLOR);
// The demo site's icon is an SVG, to exercise that path too.
const BYTE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path fill="#fff" d="M20 14h15c7 0 11 3.6 11 9 0 3.6-1.900 6.200-5 7.500 4.200 1.100 7 4.300 7 8.800C48 45.900 43.300 50 35.500 50H20zm8 6.500v8h6c3 0 4.700-1.500 4.700-4s-1.700-4-4.700-4zm0 14.200v8.800h7c3.300 0 5.100-1.600 5.100-4.400s-1.800-4.400-5.100-4.400z"/></svg>`;

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
    if (/passkey/i.test(pageText)) return PASSKEYS_ANSWER;
    return /sourdough/i.test(pageText) ? SOURDOUGH_ANSWER : `Mock answer to: ${lastUserText}`;
  }
  if (/passkey/i.test(pageText)) return PASSKEYS_SUMMARY;
  if (/sourdough/i.test(pageText)) return SOURDOUGH_SUMMARY;
  return `**TL;DR:** Mock summary of "${titleOf(pageText)}".\n\n- First point\n- Second point`;
}

// A rating request is recognised by its system prompt. The "model" knows two sources.
const isRatingRequest = (system) => /rate how far a reader can generally trust/.test(String(system));
function ratingReply(source) {
  if (/Byte Review/.test(source)) return '{"level": 4, "reason": "Established technology publication with named authors"}';
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
  const state = { chunkDelay: 6, changes: 0, iconRequests: 0, faviconRequests: 0, faviconByHost: {} };

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
      // The browser fetches icons for its own tabs too ("image" requests). Only
      // the extension's fetches are counted; those are plain fetch() calls.
      const fromExtension = req.headers['sec-fetch-dest'] === 'empty';
      if (url.pathname === '/icon.png') {
        if (fromExtension) state.iconRequests++;
        return send(200, 'image/png', ICON_PNG);
      }
      if (url.pathname === '/byte.svg') return send(200, 'image/svg+xml', BYTE_SVG);
      if (url.pathname === '/favicon.ico') {
        if (fromExtension) state.faviconRequests++; // this site has none: the address answers 404
        // Chrome sends no fetch metadata to plain-http sites, so also count per site name.
        const site = String(req.headers.host || '').split(':')[0];
        state.faviconByHost[site] = (state.faviconByHost[site] || 0) + 1;
        return send(404, 'text/html; charset=utf-8', '<h1>404 Not Found</h1>');
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
