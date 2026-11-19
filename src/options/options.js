// Settings page. Also shown as the toolbar popup (?popup=1). Everything saves
// as you type; there is no Save button.

import {
  DEFAULT_FORMAT,
  DEFAULT_TRIGGER,
  FORMAT_PRESETS,
  PROVIDERS,
  loadSettings,
  resolveBaseUrl,
  resolveProvider,
  saveSettings,
} from '../lib/settings.js';
import { listModels } from '../lib/providers.js';

const $ = (id) => document.getElementById(id);
const CUSTOM = '__custom__';
// IDs from a provider's model list that cannot summarize text.
const NOT_CHAT = /embed|whisper|tts|audio|speech|image|dall-e|sora|video|moderation|realtime|transcri|rerank|guard/i;
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');

let settings;
let pending = {};
let saveTimer = 0;
let checkTimer = 0;
let checkRun = 0;
let capturing = false;
const fetchedModels = { anthropic: [], openai: [] };

if (new URLSearchParams(location.search).has('popup')) document.documentElement.classList.add('popup');

// ── Saving ───────────────────────────────────────────────────────────────

function save(patch) {
  Object.assign(settings, patch);
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 600); // stays under chrome.storage.sync's write quota
}

async function flush() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const patch = pending;
  pending = {};
  const saved = $('saved');
  try {
    await saveSettings(patch);
    saved.textContent = 'Saved';
  } catch {
    pending = { ...patch, ...pending }; // keep it for the next attempt
    saved.textContent = 'Could not save yet';
    saveTimer = setTimeout(flush, 5000);
  }
  saved.classList.add('show');
  setTimeout(() => saved.classList.remove('show'), 1200);
}

// The popup can close at any moment: do not lose the last keystrokes.
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.hidden && flush());

// ── API key and model ────────────────────────────────────────────────────

function setKeyStatus(text, kind = '') {
  const el = $('key-status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function scheduleKeyCheck(delay = 700) {
  clearTimeout(checkTimer);
  checkRun++; // cancels a check that is still in flight
  if (!settings.apiKey) {
    setKeyStatus('');
    return;
  }
  setKeyStatus('Checking the key…');
  checkTimer = setTimeout(checkKey, delay);
}

async function checkKey() {
  const run = ++checkRun;
  const provider = resolveProvider(settings);
  const { label } = PROVIDERS[provider];
  try {
    const models = await listModels({
      provider,
      apiKey: settings.apiKey,
      baseUrl: resolveBaseUrl(settings, provider),
    });
    if (run !== checkRun) return;
    fetchedModels[provider] = models.filter((model) => !NOT_CHAT.test(model.id));
    setKeyStatus(`✓ ${label} key works`, 'ok');
    renderModels();
  } catch (err) {
    if (run !== checkRun) return;
    if (err.code === 'auth') setKeyStatus(`✗ ${err.message}`, 'bad');
    else setKeyStatus(`Could not verify the key: ${err.message} It may still work.`);
  }
}

function renderModels() {
  const provider = resolveProvider(settings);
  const info = PROVIDERS[provider];
  const current = settings.models[provider];
  const select = $('model');
  const option = (value, text) => {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = text;
    return el;
  };

  const known = new Set(info.models.map((model) => model.id));
  const options = info.models.map((model) =>
    option(
      model.id === info.defaultModel ? '' : model.id,
      `${model.label} · ${model.hint}${model.id === info.defaultModel ? ' (default)' : ''}`,
    ),
  );
  const extra = fetchedModels[provider].filter((model) => !known.has(model.id));
  if (extra.length) {
    const group = document.createElement('optgroup');
    group.label = 'More from your account';
    group.append(...extra.map((model) => option(model.id, model.label)));
    options.push(group);
  }
  options.push(option(CUSTOM, 'Custom model ID…'));
  select.replaceChildren(...options);

  const listed = current === '' || current === info.defaultModel || known.has(current) || extra.some((m) => m.id === current);
  select.value = !listed ? CUSTOM : current === info.defaultModel ? '' : current;
  $('custom-model').hidden = select.value !== CUSTOM;
  $('custom-model').value = listed ? '' : current;
  $('base-url').placeholder = info.baseUrl;
}

function setModel(value) {
  const provider = resolveProvider(settings);
  save({ models: { ...settings.models, [provider]: value.trim() } });
}

// ── Format ───────────────────────────────────────────────────────────────

function renderPresets() {
  const format = $('format').value.trim();
  $('presets').replaceChildren(
    ...FORMAT_PRESETS.map((preset) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${preset.prompt === format ? ' active' : ''}`;
      chip.textContent = preset.label;
      chip.setAttribute('aria-pressed', String(preset.prompt === format));
      chip.addEventListener('click', () => {
        $('format').value = preset.prompt;
        save({ format: preset.prompt });
        renderPresets();
      });
      return chip;
    }),
  );
}

// ── Shortcut ─────────────────────────────────────────────────────────────

function renderTrigger() {
  $('trigger').textContent = capturing ? 'Press a key…' : settings.trigger.label;
  $('trigger').classList.toggle('capturing', capturing);
  $('hint-key').textContent = settings.trigger.label;
}

function keyLabel(event) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

function stopCapture() {
  capturing = false;
  renderTrigger();
}

window.addEventListener(
  'keydown',
  (event) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return stopCapture();
    if (event.key === 'Alt') {
      save({ trigger: { kind: 'mod', mod: 'alt', label: IS_MAC ? '⌥ Option' : 'Alt' } });
    } else if (['Shift', 'Control', 'Meta', 'CapsLock', 'Tab', 'Enter', ' '].includes(event.key) || !event.code) {
      $('trigger-help').textContent = 'That key is taken by the browser. Press a letter, a digit or Alt/Option.';
      return undefined;
    } else {
      save({ trigger: { kind: 'key', code: event.code, label: keyLabel(event) } });
    }
    return stopCapture();
  },
  true,
);

// ── Wiring ───────────────────────────────────────────────────────────────

async function init() {
  settings = await loadSettings();

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('link-anthropic').href = PROVIDERS.anthropic.keyUrl;
  $('link-openai').href = PROVIDERS.openai.keyUrl;
  $('api-key').value = settings.apiKey;
  $('format').value = settings.format;
  $('format').placeholder = DEFAULT_FORMAT;
  $('provider').value = settings.provider;
  $('base-url').value = settings.baseUrl;
  renderModels();
  renderPresets();
  renderTrigger();
  scheduleKeyCheck(0);

  $('api-key').addEventListener('input', (event) => {
    save({ apiKey: event.target.value.trim() });
    renderModels(); // the key decides the provider
    scheduleKeyCheck();
  });
  $('toggle-key').addEventListener('click', () => {
    const input = $('api-key');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('toggle-key').textContent = reveal ? 'Hide' : 'Show';
  });

  $('model').addEventListener('change', (event) => {
    const custom = event.target.value === CUSTOM;
    $('custom-model').hidden = !custom;
    if (custom) $('custom-model').focus();
    else setModel(event.target.value);
  });
  $('custom-model').addEventListener('input', (event) => setModel(event.target.value));

  $('format').addEventListener('input', (event) => {
    save({ format: event.target.value });
    renderPresets();
  });

  $('trigger').addEventListener('click', () => {
    capturing = !capturing;
    renderTrigger();
  });
  $('trigger').addEventListener('blur', () => capturing && stopCapture());
  $('reset-trigger').addEventListener('click', () => {
    save({ trigger: { ...DEFAULT_TRIGGER } });
    stopCapture();
  });

  $('provider').addEventListener('change', (event) => {
    save({ provider: event.target.value });
    renderModels();
    scheduleKeyCheck(0);
  });
  $('base-url').addEventListener('input', (event) => {
    save({ baseUrl: event.target.value.trim() });
    scheduleKeyCheck();
  });
}

init();
