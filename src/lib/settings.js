// Settings shared by the service worker and the settings page.
//
// Two stores, on purpose:
//   IndexedDB (extension origin)  the API key and base URL. Only the
//                                 extension's own pages and service worker can
//                                 open it. Content scripts run inside web pages
//                                 and can read chrome.storage, so the key must
//                                 never be put there.
//   chrome.storage.sync           harmless preferences (format prompt, model,
//                                 shortcut). The content script reads the
//                                 shortcut from here.

export const FORMAT_PRESETS = [
  {
    id: 'points',
    label: 'Key points',
    prompt: [
      'Start with a one-sentence TL;DR in bold.',
      'Then give the 4 to 7 key points as short bullets: concrete facts, numbers, names and conclusions, not vague descriptions.',
      'Finish with a "Worth knowing" line only if there is a caveat, date, price or bias I should be aware of.',
      'Keep it under 150 words.',
    ].join('\n'),
  },
  {
    id: 'brief',
    label: 'Brief',
    prompt: [
      'Summarize in 2 or 3 plain sentences. No bullets, no headings.',
      'Tell me what the page is and the single most important thing it says.',
    ].join('\n'),
  },
  {
    id: 'detailed',
    label: 'Detailed',
    prompt: [
      'Start with a one-sentence TL;DR in bold.',
      'Then write a structured summary with short headings and bullets that covers every important point, number, name and conclusion.',
      'End with a "Bottom line" sentence. Up to 350 words.',
    ].join('\n'),
  },
];

export const DEFAULT_FORMAT = FORMAT_PRESETS[0].prompt;
export const MAX_FORMAT_CHARS = 4000;

/** Hold this key (or modifier) and click a link to peek at it. */
export const DEFAULT_TRIGGER = Object.freeze({ kind: 'key', code: 'KeyX', label: 'X' });

export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'best quality' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'faster' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'fastest, cheapest' },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-6.2-sol',
    models: [
      { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', hint: 'everyday default' },
      { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', hint: 'most capable' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', hint: 'fast' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', hint: 'cheapest' },
    ],
  },
};

const SECRET_DEFAULTS = { apiKey: '', baseUrl: '' };
const PREF_DEFAULTS = {
  provider: 'auto', // 'auto' | 'anthropic' | 'openai'
  models: { anthropic: '', openai: '' }, // '' means "use the provider default"
  format: DEFAULT_FORMAT,
  trigger: DEFAULT_TRIGGER,
  reputation: true, // show the model's estimate of how trustworthy the source is
};

export const DEFAULTS = { ...SECRET_DEFAULTS, ...PREF_DEFAULTS };

/** Tell the two key families apart. Returns null when there is no key. */
export function detectProvider(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  return key.startsWith('sk-ant-') ? 'anthropic' : 'openai';
}

export function resolveProvider(settings) {
  if (settings.provider === 'anthropic' || settings.provider === 'openai') return settings.provider;
  return detectProvider(settings.apiKey) || 'anthropic';
}

export function resolveModel(settings, provider = resolveProvider(settings)) {
  return String(settings.models?.[provider] || '').trim() || PROVIDERS[provider].defaultModel;
}

export function resolveBaseUrl(settings, provider = resolveProvider(settings)) {
  const custom = String(settings.baseUrl || '').trim();
  return (custom || PROVIDERS[provider].baseUrl).replace(/\/+$/, '');
}

export function normalizeTrigger(trigger) {
  if (trigger?.kind === 'mod' && trigger.mod === 'alt') {
    return { kind: 'mod', mod: 'alt', label: String(trigger.label || 'Alt') };
  }
  if (trigger?.kind === 'key' && typeof trigger.code === 'string' && trigger.code) {
    return { kind: 'key', code: trigger.code, label: String(trigger.label || trigger.code) };
  }
  return { ...DEFAULT_TRIGGER };
}

function normalize(raw) {
  const format = String(raw.format ?? '').trim();
  return {
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || '').trim(),
    provider: ['anthropic', 'openai'].includes(raw.provider) ? raw.provider : 'auto',
    models: {
      anthropic: String(raw.models?.anthropic || '').trim(),
      openai: String(raw.models?.openai || '').trim(),
    },
    format: (format || DEFAULT_FORMAT).slice(0, MAX_FORMAT_CHARS),
    trigger: normalizeTrigger(raw.trigger),
    reputation: raw.reputation !== false,
  };
}

// ── Secrets: a one-record IndexedDB store ────────────────────────────────

const DB_NAME = 'linkpeek';
const DB_STORE = 'secrets';
const DB_KEY = 'current';

/** Runs `work(store)` in one transaction and resolves with its request's result. */
function withSecretStore(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(DB_STORE, mode);
      let result;
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      work(tx.objectStore(DB_STORE), (value) => {
        result = value;
      });
    };
  });
}

function readSecrets() {
  return withSecretStore('readonly', (store, done) => {
    const request = store.get(DB_KEY);
    request.onsuccess = () => done({ ...SECRET_DEFAULTS, ...request.result });
  });
}

function writeSecrets(patch) {
  return withSecretStore('readwrite', (store) => {
    const request = store.get(DB_KEY);
    request.onsuccess = () => store.put({ ...SECRET_DEFAULTS, ...request.result, ...patch }, DB_KEY);
  });
}

export async function loadSettings() {
  const [secrets, prefs] = await Promise.all([readSecrets(), chrome.storage.sync.get(PREF_DEFAULTS)]);
  return normalize({ ...secrets, ...prefs });
}

export async function saveSettings(patch) {
  const secrets = {};
  const prefs = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in SECRET_DEFAULTS) secrets[key] = value;
    else if (key in PREF_DEFAULTS) prefs[key] = value;
  }
  await Promise.all([
    Object.keys(secrets).length ? writeSecrets(secrets) : null,
    Object.keys(prefs).length ? chrome.storage.sync.set(prefs) : null,
  ]);
}
