import test from 'node:test';
import assert from 'node:assert/strict';
import { sseEvents } from '../../src/lib/sse.js';

function streamOf(...chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of sseEvents(stream)) events.push(event);
  return events;
}

test('parses events and their names', async () => {
  const events = await collect(streamOf('event: greeting\ndata: hello\n\ndata: plain\n\n'));
  assert.deepEqual(events, [
    { event: 'greeting', data: 'hello' },
    { event: 'message', data: 'plain' },
  ]);
});

test('survives chunk boundaries in awkward places', async () => {
  const events = await collect(streamOf('da', 'ta: {"a"', ':1}\n', '\ndata: two\n\n'));
  assert.deepEqual(events.map((e) => e.data), ['{"a":1}', 'two']);
});

test('handles CRLF, even when split across chunks', async () => {
  const events = await collect(streamOf('data: one\r', '\n\r\ndata: two\r\n\r\n'));
  assert.deepEqual(events.map((e) => e.data), ['one', 'two']);
});

test('joins multi-line data and skips comments', async () => {
  const events = await collect(streamOf(': keep-alive\n\ndata: a\ndata: b\n\n'));
  assert.deepEqual(events, [{ event: 'message', data: 'a\nb' }]);
});

test('multi-byte characters split across chunks decode correctly', async () => {
  const bytes = new TextEncoder().encode('data: héllo ✓\n\n');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 8)); // cuts "é" in half
      controller.enqueue(bytes.slice(8));
      controller.close();
    },
  });
  assert.deepEqual((await collect(stream)).map((e) => e.data), ['héllo ✓']);
});

test('yields a final event that has no trailing blank line', async () => {
  const events = await collect(streamOf('data: first\n\ndata: last'));
  assert.deepEqual(events.map((e) => e.data), ['first', 'last']);
});
