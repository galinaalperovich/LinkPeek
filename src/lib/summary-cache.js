// Remembers finished summaries, so peeking at a page that has not changed is
// instant and costs nothing.
//
// The key is a SHA-256 hash of everything that shapes a summary: the page's
// content, the format prompt, and the provider and model. If any of them
// changes, the hash changes and a new summary is made. The link itself is still
// fetched every time, because that is the only way to know the content is the
// same.
//
// Entries live in the extension's own IndexedDB (not reachable from web pages
// or content scripts), are dropped after 30 days, and are capped in number.

const DB_NAME = 'linkpeek-cache';
const STORE = 'summaries';
export const MAX_ENTRIES = 300;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {{ provider: string, model: string, system: string, page: object }} input
 * @returns {Promise<string>} hex SHA-256
 */
export async function summaryKey({ provider, model, system, page }) {
  const content = page.kind === 'pdf' ? page.pdf?.data || '' : page.text || '';
  // The address is deliberately left out: the same content at another URL
  // (a tracking parameter, a mirror) deserves the same summary.
  const material = JSON.stringify([provider, model, system, page.kind || 'html', page.title || '', content]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function withStore(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      let result;
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      work(tx.objectStore(STORE), (value) => {
        result = value;
      });
    };
  });
}

/** @returns {Promise<{ text: string, at: number } | null>} */
export async function readSummary(key) {
  const entry = await withStore('readonly', (store, done) => {
    const request = store.get(key);
    request.onsuccess = () => done(request.result || null);
  });
  return entry && Date.now() - entry.at <= MAX_AGE_MS ? { text: entry.text, at: entry.at } : null;
}

export function writeSummary(key, text) {
  return withStore('readwrite', (store) => {
    store.put({ key, text, at: Date.now() });
    // Keep the newest MAX_ENTRIES: walk from the oldest and delete the surplus.
    const count = store.count();
    count.onsuccess = () => {
      let surplus = count.result - MAX_ENTRIES;
      if (surplus <= 0) return;
      const walk = store.index('at').openCursor();
      walk.onsuccess = () => {
        const cursor = walk.result;
        if (!cursor || surplus <= 0) return;
        cursor.delete();
        surplus--;
        cursor.continue();
      };
    };
  });
}

export function clearSummaries() {
  return withStore('readwrite', (store) => store.clear());
}

export function countSummaries() {
  return withStore('readonly', (store, done) => {
    const request = store.count();
    request.onsuccess = () => done(request.result);
  });
}
