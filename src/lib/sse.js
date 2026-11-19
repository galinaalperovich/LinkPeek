// Minimal Server-Sent Events reader for fetch() response bodies.

function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank or comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/**
 * Yields `{ event, data }` for every event in the stream. Stopping the
 * iteration early cancels the underlying HTTP request.
 * @param {ReadableStream<Uint8Array>} body
 */
export async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) yield event;
      }
    }
    const tail = parseBlock((buffer + decoder.decode()).replace(/\r\n/g, '\n').trim());
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}
