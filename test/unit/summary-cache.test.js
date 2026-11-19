import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryKey } from '../../src/lib/summary-cache.js';

const base = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  system: 'SYSTEM with the format prompt',
  page: { kind: 'html', url: 'https://example.com/a', title: 'A title', text: 'The body of the page.' },
};
const withPage = (page) => ({ ...base, page: { ...base.page, ...page } });

test('the cache key is a stable SHA-256 of what shapes a summary', async () => {
  const key = await summaryKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await summaryKey(structuredClone(base)), key);
});

test('any change to the content, the format or the model changes the key', async () => {
  const key = await summaryKey(base);
  const variants = [
    withPage({ text: 'The body of the page!' }),
    withPage({ title: 'Another title' }),
    { ...base, system: 'SYSTEM with another format prompt' },
    { ...base, model: 'claude-haiku-5-5' },
    { ...base, provider: 'openai' },
  ];
  for (const variant of variants) assert.notEqual(await summaryKey(variant), key);
});

test('the same content at another address shares the key', async () => {
  assert.equal(await summaryKey(withPage({ url: 'https://example.com/a?utm_source=x' })), await summaryKey(base));
});

test('PDFs are keyed by their bytes', async () => {
  const pdf = (data) => ({ ...base, page: { kind: 'pdf', url: 'https://example.com/a.pdf', title: 'a.pdf', text: '', pdf: { data, name: 'a.pdf' } } });
  assert.equal(await summaryKey(pdf('QUJD')), await summaryKey(pdf('QUJD')));
  assert.notEqual(await summaryKey(pdf('QUJD')), await summaryKey(pdf('QUJE')));
});
