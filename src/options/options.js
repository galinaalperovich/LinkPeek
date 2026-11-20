// Settings page. Also shown as the toolbar popup (?popup=1).
//
// How saving works, and how the page says so:
//   - Summary format: an explicit Save button. It lights up while there are
//     unsaved edits and confirms with a green "✓ Saved".
//   - Everything else (key, model, shortcut, advanced): saved as soon as it
//     changes, confirmed by a green "✓ Saved" in the corner of that card.
//
// The first card is the choice of who writes the summaries: "Keyless"
// (Chrome's built-in AI, on this computer) or "Your key" (Claude or OpenAI).
// The choice is the reader's: a saved key never switches the mode by itself.
// This page is also where the built-in model's one-time download is started,
// because Chrome only allows that from a click in a visible page.

import {
  DEFAULT_FORMAT,
  DEFAULT_TRIGGER,
  FORMAT_PRESETS,
  PROVIDERS,
  THEMES,
  loadSettings,
  resolveBaseUrl,
  resolveKeyProvider,
  resolveMode,
  saveSettings,
} from '../lib/settings.js';
import { listModels } from '../lib/providers.js';
import { builtinState, sessionOptions } from '../lib/builtin-ai.js';
import { clearSummaries, countSummaries } from '../lib/summary-cache.js';

const $ = (id) => document.getElementById(id);
const CUSTOM = '__custom__';
// IDs from a provider's model list that cannot summarize text.
const NOT_CHAT = /embed|whisper|tts|audio|speech|image|dall-e|sora|video|moderation|realtime|transcri|rerank|guard/i;
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
// Which card confirms a change to which setting.
const CARD_OF = {
  apiKey: 'key', models: 'key', mode: 'key', trigger: 'shortcut',
  provider: 'advanced', baseUrl: 'advanced', reputation: 'advanced', theme: 'design',
};
const TRIGGER_HELP =
  'Any letter or digit works, and so does Alt/Option. You can also right-click a link and choose “Peek at this link”.';
const CAPTURE_HELP = 'Press the letter or digit you want to hold while clicking. Esc cancels.';

let settings;
let pending = {};
let saveTimer = 0;
let checkTimer = 0;
let checkRun = 0;
let capturing = false;
let savedFormat = ''; // the format text as last saved
let formatTimer = 0;
const flashTimers = {};
const fetchedModels = { anthropic: [], openai: [] };
let builtin = 'checking'; // then one of builtinState()'s answers
let builtinBusy = false; // a model download started from this page is running
let builtinNote = ''; // progress or an error, shown instead of the usual text
let builtinTimer = 0;

if (new URLSearchParams(location.search).has('popup')) document.documentElement.classList.add('popup');

// ── Saving ───────────────────────────────────────────────────────────────

function flash(card, text = '✓ Saved', bad = false) {
  const el = $(`saved-${card}`);
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(flashTimers[card]);
  flashTimers[card] = setTimeout(() => el.classList.remove('show'), 2200);
}

/** Auto-saved settings. Typing is debounced; discrete choices pass `now`. */
function save(patch, { now = false } = {}) {
  Object.assign(settings, patch);
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  if (now) flush();
  else saveTimer = setTimeout(flush, 600); // stays under chrome.storage.sync's write quota
}

async function flush() {
  clearTimeout(saveTimer);
  const keys = Object.keys(pending);
  if (!keys.length) return;
  const patch = pending;
  pending = {};
  const cards = [...new Set(keys.map((key) => CARD_OF[key]).filter(Boolean))];
  try {
    await saveSettings(patch);
    for (const card of cards) flash(card);
  } catch {
    pending = { ...patch, ...pending }; // keep it for the next attempt
    for (const card of cards) flash(card, 'Could not save', true);
    saveTimer = setTimeout(flush, 5000);
  }
}

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
  const provider = resolveKeyProvider(settings);
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
  const provider = resolveKeyProvider(settings);
  const info = PROVIDERS[provider];
  const current = settings.models[provider] || '';
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

function setModel(value, options) {
  const provider = resolveKeyProvider(settings);
  save({ models: { ...settings.models, [provider]: value.trim() } }, options);
}

// ── Keyless or your key ──────────────────────────────────────────────────

function renderMode() {
  const mode = resolveMode(settings);
  for (const tile of document.querySelectorAll('#modes .mode')) {
    tile.setAttribute('aria-checked', String(tile.dataset.mode === mode));
  }
  $('keyless-panel').hidden = mode !== 'keyless';
  $('key-panel').hidden = mode !== 'key';
  $('format-card').hidden = mode !== 'key'; // Keyless has one set format, nothing to describe
  renderBuiltin();
}

function chooseMode(mode) {
  if (mode === resolveMode(settings) && settings.mode) return;
  save({ mode }, { now: true });
  renderMode();
  if (mode === 'key') {
    scheduleKeyCheck(0);
    if (!settings.apiKey) $('api-key').focus();
  } else if (builtin === 'downloadable') {
    turnOnBuiltin({ quiet: true }); // choosing Keyless is the click Chrome asks for
  } else {
    checkBuiltin();
  }
}

// ── Chrome's built-in AI (Keyless) ───────────────────────────────────────

function renderBuiltin() {
  let text = '';
  let kind = '';
  let action = '';
  if (builtin === 'checking') {
    text = 'Checking this computer…';
  } else if (builtin === 'available') {
    kind = 'ok';
    text = `✓ Ready on this computer. Hold ${settings.trigger.label} and click any link.`;
  } else if (builtin === 'downloadable') {
    text = 'One step left: Chrome downloads its AI model once (about 4 GB). It starts with your first click on this page, or with your first peek. After that Keyless also works offline.';
    action = 'Turn on';
  } else if (builtin === 'downloading') {
    text = 'Chrome is downloading its AI model. This can take a few minutes.';
    action = 'Show progress';
  } else if (builtin === 'unavailable') {
    kind = 'bad';
    text = 'Keyless cannot run on this computer. Chrome’s built-in AI needs about 22 GB of free disk space, and 16 GB of memory or a recent graphics card. Choose “Your key” instead.';
  } else {
    kind = 'bad';
    text = 'Keyless cannot run in this browser. It needs Chrome 138 or newer on a computer. Choose “Your key” instead.';
  }
  const status = $('builtin-status');
  status.textContent = builtinNote || text;
  status.className = `status ${builtinNote ? '' : kind}`.trim();
  status.dataset.state = builtin;
  $('builtin-on').hidden = !action || builtinBusy;
  $('builtin-on').textContent = action;
  $('builtin-progress').hidden = !builtinBusy;
}

async function checkBuiltin() {
  clearTimeout(builtinTimer);
  if (builtinBusy) return;
  builtin = await builtinState();
  if (builtinBusy) return;
  // First visit: nothing chosen yet. Start from what this computer can do,
  // and from then on the choice is only ever changed by the reader.
  if (!settings.mode) {
    const usable = ['available', 'downloadable', 'downloading'].includes(builtin);
    settings.mode = settings.apiKey || !usable ? 'key' : 'keyless';
    saveSettings({ mode: settings.mode }).catch(() => {});
    renderMode();
  }
  renderBuiltin();
  // A download started elsewhere, or by Chrome itself: keep looking.
  if (builtin === 'downloading') builtinTimer = setTimeout(checkBuiltin, 4000);
}

// Chrome starts the model's download only inside a user gesture, so it cannot
// begin by itself when this page opens after installing. The first click or
// key press here is the earliest moment there is, and it is taken, unless that
// click is the reader choosing "Your key" instead.
function onFirstGesture(event) {
  if (!event.isTrusted || builtinBusy || builtin !== 'downloadable' || resolveMode(settings) !== 'keyless') return;
  if (event.target instanceof Element && event.target.closest('.mode[data-mode="key"]')) return;
  turnOnBuiltin({ quiet: true });
}

// Creating a session is what makes Chrome fetch the model. It must happen in
// a click handler: Chrome refuses to start the download otherwise. `quiet`
// is for the automatic start, where a refusal is not the reader's concern.
async function turnOnBuiltin({ quiet = false } = {}) {
  if (builtinBusy) return;
  builtinBusy = true;
  builtinNote = 'Starting…';
  const bar = $('builtin-progress');
  bar.removeAttribute('value'); // no number yet: show it as busy
  renderBuiltin();
  let failure = '';
  try {
    const session = await globalThis.LanguageModel.create({
      ...sessionOptions(),
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          const done = Number(event.loaded) / (Number(event.total) || 1);
          if (!(done >= 0)) return;
          bar.value = Math.min(1, done);
          builtinNote = done >= 1 ? 'Almost ready: starting the model…' : `Downloading Chrome’s AI model… ${Math.floor(done * 100)}%. You can keep browsing.`;
          renderBuiltin();
        });
      },
    });
    session.destroy();
  } catch (err) {
    if (!(quiet && err?.name === 'NotAllowedError')) failure = `Could not turn it on: ${String(err?.message || err)}`;
  }
  builtinBusy = false;
  builtinNote = '';
  builtin = await builtinState();
  if (failure && builtin !== 'available') builtinNote = failure;
  renderBuiltin();
  builtinNote = '';
}

// ── Summary format (explicit Save) ───────────────────────────────────────

const formatDirty = () => $('format').value !== savedFormat;

function renderFormatState(message = '', kind = '') {
  const dirty = formatDirty();
  $('save-format').disabled = !dirty;
  const state = $('format-state');
  state.textContent = message || (dirty ? 'Unsaved changes' : '');
  state.className = `state ${message ? kind : ''}`.trim();
}

async function saveFormat() {
  const value = $('format').value;
  clearTimeout(formatTimer);
  try {
    await saveSettings({ format: value });
  } catch {
    renderFormatState('Could not save. Try again.', 'bad');
    return;
  }
  settings.format = value;
  savedFormat = value;
  renderPresets();
  renderFormatState('✓ Saved. Used from your next peek.', 'ok');
  formatTimer = setTimeout(() => renderFormatState(), 2600);
}

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
        $('format').value = preset.prompt; // choosing a preset applies it right away
        saveFormat();
      });
      return chip;
    }),
  );
}

// ── Design ───────────────────────────────────────────────────────────────

function renderThemes() {
  $('themes').replaceChildren(
    ...THEMES.map((theme) => {
      const [bg, fg, accent] = theme.swatch || ['linear-gradient(135deg, #ffffff 50%, #1f2024 50%)', '#8a8d94', '#f5a524'];
      const tile = document.createElement('span');
      tile.className = 'theme-tile';
      tile.style.background = bg;
      for (const tag of ['i', 'i', 'i', 'b']) {
        const mark = document.createElement(tag);
        mark.style.background = tag === 'b' ? accent : fg;
        tile.append(mark);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme';
      button.dataset.theme = theme.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(theme.id === settings.theme));
      button.title = theme.hint;
      button.append(tile, theme.label);
      button.addEventListener('click', () => {
        save({ theme: theme.id }, { now: true });
        renderThemes();
      });
      return button;
    }),
  );
  $('theme-hint').textContent = THEMES.find((theme) => theme.id === settings.theme)?.hint || '';
}

// ── Shortcut ─────────────────────────────────────────────────────────────

function renderTrigger() {
  const isDefault = settings.trigger.kind === 'key' && settings.trigger.code === DEFAULT_TRIGGER.code;
  $('trigger-key').textContent = capturing ? 'Press a key…' : settings.trigger.label;
  $('trigger-key').classList.toggle('capturing', capturing);
  $('hint-key').textContent = settings.trigger.label;
  $('change-trigger').textContent = capturing ? 'Cancel' : 'Change key';
  $('reset-trigger').disabled = capturing || isDefault;
  $('trigger-help').textContent = capturing ? CAPTURE_HELP : TRIGGER_HELP;
  renderBuiltin(); // its "ready" line names the shortcut
}

function keyLabel(event) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

function setCapturing(value) {
  capturing = value;
  renderTrigger();
}

// While "Press a key…" is showing, the next key press becomes the shortcut.
window.addEventListener(
  'keydown',
  (event) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setCapturing(false);
    } else if (event.key === 'Alt') {
      save({ trigger: { kind: 'mod', mod: 'alt', label: IS_MAC ? '⌥ Option' : 'Alt' } }, { now: true });
      setCapturing(false);
    } else if (['Shift', 'Control', 'Meta', 'CapsLock', 'Tab', 'Enter', ' '].includes(event.key) || !event.code) {
      $('trigger-help').textContent = 'That key is taken by the browser. Press a letter, a digit or Alt/Option.';
    } else {
      save({ trigger: { kind: 'key', code: event.code, label: keyLabel(event) } }, { now: true });
      setCapturing(false);
    }
  },
  true,
);

// ── Saved summaries ──────────────────────────────────────────────────────

async function renderCacheCount() {
  const count = await countSummaries().catch(() => 0);
  $('cache-count').textContent = `Saved summaries: ${count}`;
  $('clear-cache').disabled = count === 0;
}

// ── Wiring ───────────────────────────────────────────────────────────────

async function init() {
  settings = await loadSettings();
  savedFormat = settings.format;

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('link-anthropic').href = PROVIDERS.anthropic.keyUrl;
  $('link-openai').href = PROVIDERS.openai.keyUrl;
  $('api-key').value = settings.apiKey;
  $('format').value = settings.format;
  $('format').placeholder = DEFAULT_FORMAT;
  $('provider').value = settings.provider;
  $('base-url').value = settings.baseUrl;
  $('reputation').checked = settings.reputation;
  renderModels();
  renderPresets();
  renderFormatState();
  renderTrigger();
  renderThemes();
  renderCacheCount();
  scheduleKeyCheck(0);
  renderMode();
  checkBuiltin();

  for (const tile of document.querySelectorAll('#modes .mode')) {
    tile.addEventListener('click', () => chooseMode(tile.dataset.mode));
  }
  $('builtin-on').addEventListener('click', () => turnOnBuiltin());
  document.addEventListener('pointerdown', onFirstGesture, true);
  document.addEventListener('keydown', onFirstGesture, true);
  // Coming back to this page (after freeing disk space, say): look again.
  window.addEventListener('focus', () => builtin !== 'available' && checkBuiltin());

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
    else setModel(event.target.value, { now: true });
  });
  $('custom-model').addEventListener('input', (event) => setModel(event.target.value));

  $('format').addEventListener('input', () => {
    clearTimeout(formatTimer);
    renderPresets();
    renderFormatState();
  });
  $('format').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && formatDirty()) {
      event.preventDefault();
      saveFormat();
    }
  });
  $('save-format').addEventListener('click', saveFormat);

  $('change-trigger').addEventListener('click', () => setCapturing(!capturing));
  $('reset-trigger').addEventListener('click', () => {
    save({ trigger: { ...DEFAULT_TRIGGER } }, { now: true });
    setCapturing(false);
  });
  // Clicking anywhere else, or leaving the window, cancels "Press a key…".
  document.addEventListener('pointerdown', (event) => {
    if (capturing && event.target !== $('change-trigger')) setCapturing(false);
  });
  window.addEventListener('blur', () => capturing && setCapturing(false));

  $('clear-cache').addEventListener('click', async () => {
    await clearSummaries().catch(() => {});
    await renderCacheCount();
    flash('advanced', '\u2713 Cleared');
  });
  $('reputation').addEventListener('change', (event) => {
    save({ reputation: event.target.checked }, { now: true });
  });
  $('provider').addEventListener('change', (event) => {
    save({ provider: event.target.value }, { now: true });
    renderModels();
    scheduleKeyCheck(0);
  });
  $('base-url').addEventListener('input', (event) => {
    save({ baseUrl: event.target.value.trim() });
    scheduleKeyCheck();
  });

  // The popup can close at any moment. Nothing typed should be lost: not the
  // last keystrokes of an auto-saved field, not a format still waiting for Save.
  document.addEventListener('visibilitychange', () => document.hidden && flush());
  window.addEventListener('pagehide', () => {
    flush();
    if (formatDirty()) saveSettings({ format: $('format').value }).catch(() => {});
  });
}

init();
