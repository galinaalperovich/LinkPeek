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

/**
 * The bubble's designs. `auto` follows the system: Light or Dark. The swatch
 * colours are only for the picker in the settings; the designs themselves are
 * defined in ui/bubble-css.js.
 */
export const THEMES = [
  { id: 'auto', label: 'Auto', hint: 'Light or Dark, following your system' },
  { id: 'light', label: 'Light', hint: 'Clean white with an amber accent', swatch: ['#ffffff', '#1b1c1f', '#f5a524'] },
  { id: 'dark', label: 'Dark', hint: 'Graphite with an amber accent', swatch: ['#1f2024', '#e6e6e9', '#f5a524'] },
  { id: 'vision', label: 'Color-blind safe', hint: 'Blue and orange, numbers next to colors, stronger contrast', swatch: ['#ffffff', '#101216', '#0072b2'] },
  { id: 'paper', label: 'Paper', hint: 'Warm page, book typeface', swatch: ['#fbf6ea', '#33291f', '#b4532a'] },
  { id: 'midnight', label: 'Midnight', hint: 'Frosted navy glass with a violet glow', swatch: ['#151936', '#d9defa', '#8b7bff'] },
];
const THEME_IDS = THEMES.map((theme) => theme.id);

/** Hold this key (or modifier) and click a link to peek at it. */
export const DEFAULT_TRIGGER = Object.freeze({ kind: 'key', code: 'KeyX', label: 'X' });

export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    maker: 'Anthropic',
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
    maker: 'OpenAI',
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
  // No key, no account, no network: the model that ships with Chrome, run on
  // this computer (see builtin-ai.js). This is what "Keyless" uses.
  builtin: {
    id: 'builtin',
    label: "Chrome's built-in AI",
    baseUrl: '',
    keyUrl: '',
    defaultModel: 'gemini-nano',
    models: [{ id: 'gemini-nano', label: 'Gemini Nano', hint: 'runs on this computer' }],
  },
};
const KEY_PROVIDERS = ['anthropic', 'openai'];

/**
 * Who writes the summaries. The reader picks one in the settings:
 *   keyless  Chrome's built-in AI, on this computer. Free, private, limited.
 *   key      their own Claude or OpenAI key. Best quality, billed to them.
 */
export const MODES = ['keyless', 'key'];

const SECRET_DEFAULTS = { apiKey: '', baseUrl: '' };
const PREF_DEFAULTS = {
  mode: '', // one of MODES; '' until the reader has chosen (see resolveMode)
  provider: 'auto', // for "key" mode: 'auto' | 'anthropic' | 'openai'
  models: { anthropic: '', openai: '' }, // '' means "use the provider default"
  format: DEFAULT_FORMAT,
  trigger: DEFAULT_TRIGGER,
  reputation: true, // show the model's estimate of how trustworthy the source is
  theme: 'auto', // one of THEMES
};

export const DEFAULTS = { ...SECRET_DEFAULTS, ...PREF_DEFAULTS };

/** Tell the two key families apart. Returns null when there is no key. */
export function detectProvider(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  return key.startsWith('sk-ant-') ? 'anthropic' : 'openai';
}

/**
 * The mode in force. Before the reader has chosen (a fresh install, or a copy
 * from before the choice existed) a saved key means "key", no key "keyless".
 */
export function resolveMode(settings) {
  if (MODES.includes(settings.mode)) return settings.mode;
  return String(settings.apiKey || '').trim() ? 'key' : 'keyless';
}

/** The provider the API key is used with, whatever the mode. */
export function resolveKeyProvider(settings) {
  if (KEY_PROVIDERS.includes(settings.provider)) return settings.provider;
  return detectProvider(settings.apiKey) || 'anthropic';
}

/** Who answers: Chrome's built-in AI in keyless mode, else the key's provider. */
export function resolveProvider(settings) {
  return resolveMode(settings) === 'keyless' ? 'builtin' : resolveKeyProvider(settings);
}

/** Who answers, in a few words, for the bubble's footer. */
export function engineLabel(provider, settings) {
  if (provider === 'builtin') return 'AI running on this device';
  // A custom base URL can be anyone's server: name the server, not a company.
  const custom = String(settings?.baseUrl || '').trim();
  if (custom) {
    try {
      return `AI provided by ${new URL(custom).host}`;
    } catch {
      // not an address: fall through to the provider's name
    }
  }
  return `AI provided by ${PROVIDERS[provider].maker}`;
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
    mode: MODES.includes(raw.mode) ? raw.mode : '',
    provider: KEY_PROVIDERS.includes(raw.provider) ? raw.provider : 'auto',
    models: {
      anthropic: String(raw.models?.anthropic || '').trim(),
      openai: String(raw.models?.openai || '').trim(),
    },
    format: (format || DEFAULT_FORMAT).slice(0, MAX_FORMAT_CHARS),
    trigger: normalizeTrigger(raw.trigger),
    reputation: raw.reputation !== false,
    theme: THEME_IDS.includes(raw.theme) ? raw.theme : 'auto',
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
