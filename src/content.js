// LinkPeek content script: notices "hold the shortcut key and click a link",
// then shows the bubble. It never sees the API key and does no networking of
// its own. Everything goes through a port to the service worker.
(() => {
  'use strict';

  // Re-injection (install, update) can run this file twice in one page. Keep a
  // working instance, replace a dead one.
  const previous = globalThis.__linkpeek;
  if (previous?.isAlive?.()) return;
  previous?.destroy?.();

  const DEFAULT_TRIGGER = { kind: 'key', code: 'KeyX', label: 'X' };
  const STAGE_TEXT = {
    fetching: 'Reading the page…',
    rendering: 'Opening it in a background tab…',
    thinking: 'Summarizing…',
  };
  // Errors where trying again cannot help.
  const NO_RETRY = new Set(['reload', 'bad-url', 'unsupported', 'not-found', 'too-large', 'no-key']);
  const NEEDS_SETTINGS = new Set(['no-key', 'auth', 'model']);
  // Index = level, as rated by the model (see lib/reputation.js).
  const REPUTATION = [
    { label: 'Unknown', tone: 'none', means: 'The AI does not know this source well enough to rate it.' },
    { label: 'Very low', tone: 'bad', means: 'Known for unreliable or misleading content.' },
    { label: 'Low', tone: 'bad', means: 'Often unreliable. Check its claims elsewhere.' },
    { label: 'Mixed', tone: 'mid', means: 'Reliable for some things, not for others.' },
    { label: 'High', tone: 'good', means: 'A generally reliable source.' },
    { label: 'Very high', tone: 'good', means: 'Among the most reliable kinds of source.' },
  ];
  const REPUTATION_CAVEAT =
    'Decided by AI from what it knows about this publisher and author. An estimate, not a verified rating.';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    close: ['M18 6 6 18', 'M6 6l12 12'],
    open: ['M7 17 17 7', 'M8 7h9v9'],
    copy: ['M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
    check: ['M20 6 9 17l-5-5'],
    send: ['M12 19V5', 'M5 12l7-7 7 7'],
    stop: ['M8 8h8v8H8z'],
  };

  const THEMES = new Set(['light', 'dark', 'vision', 'paper', 'midnight']);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = 'auto'; // the reader's choice; 'auto' follows the system
  let trigger = DEFAULT_TRIGGER;
  let bubble = null;
  let lastContext = null; // where the context menu was last opened
  const held = new Set(); // physical keys currently down
  const listeners = [];

  const isAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  // ── Small DOM helpers ────────────────────────────────────────────────

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (name === 'class') el.className = value;
      else if (name === 'text') el.textContent = value;
      else el.setAttribute(name, value === true ? '' : String(value));
    }
    el.append(...children.filter(Boolean));
    return el;
  }

  function icon(name, size = 16) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
    for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, String(value));
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function prettyUrl(url) {
    try {
      const { hostname, pathname } = new URL(url);
      return (hostname.replace(/^www\./, '') + pathname).replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  // "2026-08-24T09:00:00Z" → "August 24, 2026". English, like the rest of the bubble.
  function formatDate(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
    // A calendar date is shown as written, not shifted into another time zone.
    const date = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(text);
    if (Number.isNaN(date.getTime())) return text.length <= 40 ? text : '';
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function timeAgo(timestamp) {
    const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  // The "TL;DR:" that opens a summary is set in italic, whether the model
  // wrote it bold, plain, or as part of a longer bold sentence.
  function italicTldr(target) {
    const first = target.firstElementChild;
    const node = first && document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode();
    const match = node && /^\s*TL;?DR:?/i.exec(node.nodeValue);
    if (!match) return;
    node.parentNode.insertBefore(h('em', { class: 'lp-tldr', text: match[0].trim() }), node);
    node.nodeValue = node.nodeValue.slice(match[0].length);
  }

  // ── Marking the link ─────────────────────────────────────────────────

  // While a bubble is open, the link it belongs to is marked on the page, the
  // way a highlighter pen would, so it is obvious what the bubble is about.
  // None of these properties changes the page's layout.
  const LINK_MARK = {
    'background-color': 'rgba(245, 165, 36, 0.3)',
    outline: '2px solid #f5a524',
    'outline-offset': '2px',
    'border-radius': '3px',
  };

  /** Marks the link and returns a function that puts its styles back exactly. */
  function markLink(anchor) {
    try {
      const style = anchor.style;
      const hadAttribute = anchor.hasAttribute('style');
      const before = Object.keys(LINK_MARK).map((name) => [
        name, style.getPropertyValue(name), style.getPropertyPriority(name),
      ]);
      for (const [name, value] of Object.entries(LINK_MARK)) style.setProperty(name, value, 'important');
      return () => {
        try {
          for (const [name, value, priority] of before) {
            if (value) style.setProperty(name, value, priority);
            else style.removeProperty(name);
          }
          if (!hadAttribute && !anchor.getAttribute('style')) anchor.removeAttribute('style');
        } catch {
          // the element is gone; nothing to restore
        }
      };
    } catch {
      return () => {};
    }
  }

  // ── The bubble ───────────────────────────────────────────────────────

  class Bubble {
    constructor({ url, linkText, point, rect, anchor }) {
      this.url = url;
      this.linkText = linkText || '';
      this.unmarkLink = anchor ? markLink(anchor) : () => {};
      this.page = null; // what the service worker read, once known
      this.history = []; // completed turns after the page: summary, Q, A, …
      this.summary = '';
      this.busy = false;
      this.closed = false;
      this.cancel = null;
      this.frame = 0;
      this.build();
      this.place(point, rect);
      this.summarize();
    }

    build() {
      this.host = document.createElement('linkpeek-bubble');
      const hostStyle = {
        all: 'initial', position: 'fixed', top: '0', left: '0', width: '0', height: '0',
        margin: '0', padding: '0', border: '0', overflow: 'visible', background: 'transparent',
        display: 'block', 'z-index': '2147483647',
      };
      for (const [name, value] of Object.entries(hostStyle)) this.host.style.setProperty(name, value, 'important');

      // Closed: the page's scripts cannot read a summary of some other site.
      this.root = this.host.attachShadow({ mode: 'closed' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(globalThis.LinkPeekCSS);
        this.root.adoptedStyleSheets = [sheet];
      } catch {
        this.root.append(h('style', { text: globalThis.LinkPeekCSS }));
      }

      const host = hostOf(this.url);
      this.titleEl = h('a', {
        class: 'lp-title', href: this.url, target: '_blank', rel: 'noopener noreferrer',
        text: this.linkText || prettyUrl(this.url), draggable: 'false',
      });
      // The site's first letter until (and unless) its real icon arrives.
      this.avatarEl = h('div', { class: 'lp-avatar', text: (host[0] || '?'), 'aria-hidden': 'true' });
      this.hostEl = h('span', { class: 'lp-host', text: host });
      this.repEl = h('button', { class: 'lp-rep', type: 'button', hidden: true });
      this.factsEl = h('span', { class: 'lp-facts' });
      this.subEl = h('div', { class: 'lp-sub' }, this.hostEl, this.repEl, this.factsEl);
      this.creditEl = h('div', { class: 'lp-credit', hidden: true });
      // Explains the reputation meter on hover or keyboard focus.
      this.tipEl = h('div', { class: 'lp-tip', role: 'tooltip', id: 'lp-rep-tip', hidden: true });
      this.copyBtn = h('button', { class: 'lp-icon', type: 'button', title: 'Copy summary', 'aria-label': 'Copy summary' }, icon('copy'));
      this.openEl = h('a', {
        class: 'lp-icon', href: this.url, target: '_blank', rel: 'noopener noreferrer',
        title: 'Open in a new tab', 'aria-label': 'Open in a new tab',
      }, icon('open'));
      const closeBtn = h('button', { class: 'lp-icon', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close' }, icon('close'));
      this.head = h('div', { class: 'lp-head' },
        this.avatarEl,
        h('div', { class: 'lp-titles' }, this.titleEl, this.subEl, this.creditEl),
        this.copyBtn, this.openEl, closeBtn);

      this.skeleton = h('div', { class: 'lp-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
      this.statusText = h('span');
      this.statusEl = h('div', { class: 'lp-status', role: 'status' },
        h('span', { class: 'lp-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), this.statusText);
      this.body = h('div', { class: 'lp-body' });

      this.input = h('textarea', {
        class: 'lp-input', rows: 1, placeholder: 'Ask about this page…',
        'aria-label': 'Ask a question about this page', disabled: true,
      });
      this.sendBtn = h('button', { class: 'lp-send', type: 'submit', title: 'Ask', 'aria-label': 'Ask', disabled: true }, icon('send'));
      this.form = h('form', { class: 'lp-ask' }, this.input, this.sendBtn);

      // A small way into the settings from every bubble.
      this.settingsBtn = h('button', { class: 'lp-settings', type: 'button', text: 'Settings' });
      this.settingsBtn.addEventListener('click', () => {
        try {
          chrome.runtime.sendMessage({ type: 'linkpeek:open-options' }).catch(() => {});
        } catch {
          // extension was reloaded
        }
      });
      this.foot = h('div', { class: 'lp-foot' }, this.settingsBtn);

      this.panel = h('div', { class: 'lp', role: 'dialog', 'aria-label': 'LinkPeek summary' }, this.head, this.body, this.form, this.foot);
      this.root.append(this.panel, this.tipEl);
      this.applyTheme();

      closeBtn.addEventListener('click', () => this.close());
      // Two things in the header explain themselves in a hover card: the
      // reputation meter, and the title, which is often too long for one line.
      const card = (el, content) => {
        el.addEventListener('mouseenter', () => this.showTip(el, content()));
        el.addEventListener('mouseleave', () => this.hideTip());
        el.addEventListener('focus', () => this.showTip(el, content()));
        el.addEventListener('blur', () => this.hideTip());
      };
      card(this.repEl, () => this.repCard);
      card(this.titleEl, () => [
        h('div', { class: 'lp-tip-title' }, h('strong', { text: this.titleEl.textContent })),
        h('div', { class: 'lp-tip-foot lp-tip-url', text: this.page?.url || this.url }),
      ]);
      this.copyBtn.addEventListener('click', () => this.copy());
      this.head.addEventListener('pointerdown', (event) => this.startDrag(event));
      this.input.addEventListener('input', () => this.syncInput());
      for (const type of ['wheel', 'touchmove']) {
        this.body.addEventListener(type, () => { this.followEl = null; }, { passive: true });
      }
      this.form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (this.busy) this.cancel?.();
        else this.submit();
      });
      // What happens in the bubble stays in the bubble: page-level click and
      // mouse handlers should not react to it.
      for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
        this.panel.addEventListener(type, (event) => event.stopPropagation());
      }

      document.documentElement.append(this.host);
      try {
        // The top layer keeps the bubble above modals and fullscreen elements.
        this.host.popover = 'manual';
        this.host.showPopover();
      } catch {
        // Plain z-index it is.
      }
    }

    // The design is one class, on the panel and on the hover card beside it.
    applyTheme() {
      const name = THEMES.has(theme) ? theme : prefersDark.matches ? 'dark' : 'light';
      this.panel.className = `lp lp-t-${name}`;
      this.tipEl.className = `lp-tip lp-t-${name}`;
    }

    // Next to the link: below it when there is room, above it otherwise.
    place(point, rect) {
      const viewW = document.documentElement.clientWidth || window.innerWidth;
      const viewH = window.innerHeight;
      const margin = 12;
      const gap = 10;
      const width = Math.min(420, viewW - margin * 2);
      const at = point || { x: viewW / 2, y: viewH / 4 };
      const box = rect && rect.height > 0 && rect.height <= 80 ? rect : { top: at.y - 10, bottom: at.y + 10 };
      const below = viewH - box.bottom - gap - margin;
      const above = box.top - gap - margin;
      const wanted = Math.min(560, viewH - margin * 2);
      const left = clamp(at.x - 56, margin, viewW - width - margin);
      const style = this.panel.style;
      style.width = `${width}px`;
      style.left = `${left}px`;
      const originX = `${clamp(at.x - left, 0, width)}px`;
      if (Math.max(below, above) < 220) {
        style.top = `${margin}px`;
        style.maxHeight = `${wanted}px`;
        style.transformOrigin = `${originX} 0`;
      } else if (below >= Math.min(wanted, 340) || below >= above) {
        style.top = `${box.bottom + gap}px`;
        style.maxHeight = `${Math.min(wanted, below)}px`;
        style.transformOrigin = `${originX} 0`;
      } else {
        style.bottom = `${viewH - box.top + gap}px`;
        style.maxHeight = `${Math.min(wanted, above)}px`;
        style.transformOrigin = `${originX} 100%`;
      }
    }

    // The whole header is a drag handle, title included: a press that moves is
    // a drag, a press that does not is an ordinary click on the title link.
    startDrag(event) {
      if (event.button !== 0 || event.target.closest?.('.lp-icon')) return;
      const rect = this.panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const style = this.panel.style;
      let dragging = false;

      const move = (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          dragging = true;
          this.hideTip();
          this.head.classList.add('lp-dragging');
          try {
            this.head.setPointerCapture(ev.pointerId);
          } catch {
            // No capture: dragging still works while the pointer stays on the header.
          }
        }
        const viewW = document.documentElement.clientWidth || window.innerWidth;
        const viewH = window.innerHeight;
        const top = clamp(rect.top + ev.clientY - startY, 4, viewH - 48);
        style.left = `${clamp(rect.left + ev.clientX - startX, 80 - rect.width, viewW - 80)}px`;
        style.top = `${top}px`;
        style.bottom = 'auto';
        style.maxHeight = `${Math.max(180, Math.min(560, viewH - top - 12))}px`;
      };
      const end = () => {
        this.head.classList.remove('lp-dragging');
        this.head.removeEventListener('pointermove', move);
        this.head.removeEventListener('pointerup', end);
        this.head.removeEventListener('pointercancel', end);
        if (!dragging) return;
        // The release that ends a drag must not also open the title link.
        const swallow = (click) => {
          click.preventDefault();
          click.stopPropagation();
        };
        this.panel.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => this.panel.removeEventListener('click', swallow, { capture: true }), 0);
      };
      this.head.addEventListener('pointermove', move);
      this.head.addEventListener('pointerup', end);
      this.head.addEventListener('pointercancel', end);
    }

    // ── State ──────────────────────────────────────────────────────────

    owns(event) {
      return event.composedPath().includes(this.host);
    }

    // Asked of the shadow root: from outside a closed root, events look as if
    // they came from the host element.
    isTyping() {
      return this.root.activeElement === this.input;
    }

    setBusy(busy) {
      this.busy = busy;
      this.sendBtn.replaceChildren(icon(busy ? 'stop' : 'send'));
      const label = busy ? 'Stop' : 'Ask';
      this.sendBtn.title = label;
      this.sendBtn.setAttribute('aria-label', label);
      this.syncInput();
    }

    syncInput() {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(Math.max(this.input.scrollHeight + 2, 34), 96)}px`;
      this.sendBtn.disabled = !this.busy && (!this.page || !this.input.value.trim());
    }

    setStatus(text) {
      this.statusText.textContent = text;
      this.statusEl.hidden = false;
      this.body.append(this.statusEl); // always last
    }

    clearStatus() {
      this.statusEl.hidden = true;
      this.skeleton.hidden = true;
    }

    setPage(page) {
      this.page = page;
      if (page.title) this.titleEl.textContent = page.title;
      for (const el of [this.titleEl, this.openEl]) el.setAttribute('href', page.url);
      const facts = [];
      if (page.kind === 'pdf') facts.push(['PDF', formatBytes(page.sizeBytes)].filter(Boolean).join(' '));
      else if (page.readMinutes) facts.push(`${page.readMinutes} min read`);
      if (page.truncated) facts.push('long page, first part only');
      this.hostEl.textContent = hostOf(page.url);
      this.factsEl.textContent = facts.length ? `· ${facts.join(' · ')}` : '';
      this.setCredit(page);
      this.requestReputation(page);
      this.requestIcon(page);
      this.input.disabled = false;
      this.syncInput();
    }

    // Third header line: who wrote the page and when, e.g.
    // "Author: Berry Mingus, August 24, 2026". Falls back to the publishing
    // organization, and is left out when the page says neither.
    setCredit(page) {
      const author = String(page.byline || '').replace(/^by\s+/i, '').trim();
      const org = String(page.siteName || '').trim();
      const date = formatDate(page.published);
      const squash = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      // "GitHub" under "github.com" says nothing new unless there is a date to go with it.
      const orgRepeatsHost = Boolean(org) && squash(hostOf(page.url)).includes(squash(org));
      let label = '';
      let name = '';
      if (author) [label, name] = ['Author', author];
      else if (org && (date || !orgRepeatsHost)) [label, name] = ['Source', org];
      else if (date) label = 'Published';

      this.creditEl.hidden = !label;
      if (!label) return;
      const rest = [name, date].filter(Boolean).join(', ');
      this.creditEl.replaceChildren(h('strong', { text: label }), `: ${rest}`);
      this.creditEl.title = `${label}: ${rest}`;
    }

    // Asked separately from the summary, so a slow or failed rating never
    // holds the summary up. No answer, no meter.
    requestReputation(page) {
      this.setReputation(null);
      this.closeReputationPort();
      let port;
      try {
        port = chrome.runtime.connect({ name: 'linkpeek' });
      } catch {
        return;
      }
      this.repPort = port;
      port.onMessage.addListener((message) => {
        if (message.type !== 'reputation' && message.type !== 'error') return;
        if (!this.closed && this.repPort === port) this.setReputation(message.rating || null);
        this.closeReputationPort();
      });
      port.onDisconnect.addListener(() => void chrome.runtime.lastError);
      port.postMessage({
        type: 'reputation',
        page: { url: page.url, title: page.title, siteName: page.siteName, byline: page.byline },
      });
    }

    // The site's own icon, fetched and decoded by the service worker.
    requestIcon(page) {
      if (this.iconFor === page.url) return; // a retry of the same page keeps its icon
      this.iconFor = page.url;
      let port;
      try {
        port = chrome.runtime.connect({ name: 'linkpeek' });
      } catch {
        return;
      }
      this.iconPort = port;
      const done = () => {
        try {
          port.disconnect();
        } catch {
          // already closed
        }
        if (this.iconPort === port) this.iconPort = null;
      };
      port.onMessage.addListener((message) => {
        if (message.type !== 'icon' && message.type !== 'error') return;
        if (!this.closed && message.icon) this.setIcon(message.icon);
        done();
      });
      port.onDisconnect.addListener(() => void chrome.runtime.lastError);
      port.postMessage({ type: 'icon', url: page.url, icon: page.icon || '' });
    }

    // Painted from raw pixels onto a canvas: no image request is made from the
    // page, so a site's security policy cannot block it.
    setIcon(icon) {
      try {
        const side = icon.size;
        const pixels = Uint8ClampedArray.from(atob(icon.rgba), (ch) => ch.charCodeAt(0));
        if (side !== 64 || pixels.length !== side * side * 4) return;
        const canvas = h('canvas', { class: 'lp-favicon', width: side, height: side });
        canvas.getContext('2d').putImageData(new ImageData(pixels, side, side), 0, 0);
        this.avatarEl.replaceChildren(canvas);
        this.avatarEl.classList.add('lp-has-icon');
      } catch {
        // keep the letter
      }
    }

    closeReputationPort() {
      try {
        this.repPort?.disconnect();
      } catch {
        // already closed
      }
      this.repPort = null;
    }

    // A five-bar meter next to the site name. Hovering it explains the rating.
    setReputation(rating) {
      const known = rating && REPUTATION[rating.level];
      this.repEl.hidden = !known;
      this.hideTip();
      if (!known) return;
      const { label, tone, means } = known;
      const bars = [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= rating.level ? 'on' : null }));
      this.repEl.className = `lp-rep lp-rep-${tone}`;
      this.repEl.replaceChildren(
        h('span', { class: 'lp-meter', 'aria-hidden': 'true' }, ...bars),
        h('span', { class: 'lp-rep-label', text: label }),
        rating.level ? h('span', { class: 'lp-rep-score', text: `${rating.level}/5` }) : null,
      );
      const score = rating.level ? `${rating.level} of 5` : '';
      const why = rating.reason ? `Why: ${rating.reason}.` : '';
      this.repCard = [
        h('div', { class: 'lp-tip-title' },
          h('strong', { text: `Source reputation: ${label}` }),
          score ? h('span', { text: score }) : null),
        h('div', { text: means }),
        why ? h('div', { text: why }) : null,
        h('div', { class: 'lp-tip-foot', text: REPUTATION_CAVEAT }),
      ];
      // The same words for screen readers, which do not get the hover card.
      this.repEl.setAttribute('aria-label',
        [`Source reputation: ${label}${score ? `, ${score}` : ''}.`, means, why, REPUTATION_CAVEAT].filter(Boolean).join(' '));
    }

    // The card is a sibling of the panel, so the panel's rounded clipping
    // cannot cut it off. It sits under the meter, or above when there is no room.
    showTip(anchor, content) {
      if (this.closed || !content || anchor.hidden) return;
      const tip = this.tipEl;
      tip.replaceChildren(...content.filter(Boolean));
      const chip = anchor.getBoundingClientRect();
      const viewW = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.min(290, viewW - 16);
      tip.hidden = false;
      tip.style.width = `${width}px`;
      tip.style.left = `${clamp(chip.left - 8, 8, viewW - width - 8)}px`;
      const height = tip.offsetHeight;
      // Under the whole header, so the card does not cover the author line.
      const below = Math.max(chip.bottom + 7, this.head.getBoundingClientRect().bottom + 4);
      const fitsBelow = below + height <= window.innerHeight - 8;
      tip.style.top = `${fitsBelow ? below : Math.max(8, chip.top - 7 - height)}px`;
    }

    hideTip() {
      this.tipEl.hidden = true;
    }

    draw(target, text, streaming) {
      const paint = () => {
        this.frame = 0;
        target.replaceChildren(globalThis.LinkPeekMarkdown.render(text, document, {
          streaming,
          baseUrl: this.page?.url || this.url,
        }));
        italicTldr(target);
        // While an answer grows, keep its question at the top of the view,
        // unless the reader has scrolled somewhere else.
        if (this.followEl?.isConnected) this.body.scrollTop = this.followEl.offsetTop - 8;
      };
      cancelAnimationFrame(this.frame);
      if (streaming) this.frame = requestAnimationFrame(paint);
      else paint(); // final text: paint now, even if the tab is in the background
    }

    // ── Requests ───────────────────────────────────────────────────────

    /**
     * Sends one request to the service worker and streams the reply into a new
     * message element. `onDone(text)` runs when a reply (even a partial one the
     * reader stopped) is in; `retry` re-issues the request after an error.
     */
    run(request, { onDone, retry }) {
      const target = h('div', { class: 'lp-md' });
      this.body.append(target);
      this.setBusy(true);

      let port;
      try {
        port = chrome.runtime.connect({ name: 'linkpeek' });
      } catch {
        target.remove();
        this.setBusy(false);
        this.fail({ code: 'reload', message: 'LinkPeek was updated. Reload this page to keep using it here.' });
        return;
      }

      let text = '';
      let settled = false;
      const settle = () => {
        settled = true;
        this.cancel = null;
        this.setBusy(false);
        this.clearStatus();
        try {
          port.disconnect();
        } catch {
          // already closed
        }
      };
      const finish = (note) => {
        settle();
        text = text.trim();
        if (text) this.draw(target, text, false);
        else target.remove();
        if (note) this.body.append(typeof note === 'string' ? h('p', { class: 'lp-note', text: note }) : note);
        if (text) onDone(text);
      };

      port.onMessage.addListener((message) => {
        if (settled || this.closed) return;
        if (message.type === 'status') {
          const asking = request.type === 'ask' && message.stage === 'thinking';
          this.setStatus(asking ? 'Thinking…' : STAGE_TEXT[message.stage] || 'Working…');
        } else if (message.type === 'page') {
          this.setPage(message.page);
        } else if (message.type === 'reset') {
          text = '';
          this.draw(target, text, true);
        } else if (message.type === 'delta') {
          text += message.text;
          this.clearStatus();
          this.draw(target, text, true);
        } else if (message.type === 'done') {
          let note = '';
          if (message.stopReason === 'length') note = 'The answer was cut off at the length limit.';
          else if (message.stopReason === 'refusal') {
            note = `The model declined to ${text.trim() ? 'continue' : 'answer'}${message.detail ? ` (${message.detail} safety filter)` : ''}.`;
          } else if (!text.trim()) note = 'The model returned an empty answer.';
          else if (message.cachedAt) note = this.cachedNote(message.cachedAt);
          finish(note);
        } else if (message.type === 'error') {
          settle();
          target.remove();
          this.fail(message, retry);
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (settled || this.closed) return;
        settle();
        target.remove();
        this.fail({ code: 'disconnected', message: 'LinkPeek lost its connection. Try again.' }, retry);
      });

      this.cancel = () => {
        if (!settled) finish(text.trim() ? 'Stopped.' : '');
      };
      port.postMessage(request);
    }

    // `fresh` skips the saved summary and asks the model again.
    summarize(fresh = false) {
      this.setReputation(null);
      this.body.replaceChildren(this.skeleton);
      this.skeleton.hidden = false;
      this.setStatus(STAGE_TEXT.fetching);
      this.run({ type: 'summarize', url: this.url, linkText: this.linkText, fresh }, {
        onDone: (text) => {
          this.summary = text;
          this.history = [{ role: 'assistant', text }];
        },
        retry: () => this.summarize(fresh),
      });
    }

    // Shown under a summary that was not made just now.
    cachedNote(cachedAt) {
      const again = h('button', { class: 'lp-linkbtn', type: 'button', text: 'Summarize again' });
      again.addEventListener('click', () => {
        if (!this.busy) this.summarize(true);
      });
      return h('p', { class: 'lp-note lp-cached' },
        `Saved summary from ${timeAgo(cachedAt)}. The page has not changed since. `, again);
    }

    submit(preset) {
      const question = (preset ?? this.input.value).trim();
      if (!question || this.busy || !this.page) return;
      this.input.value = '';
      const bubbleEl = h('div', { class: 'lp-q', text: question });
      this.body.append(bubbleEl);
      this.setStatus('Thinking…');
      this.followEl = bubbleEl;
      this.body.scrollTop = bubbleEl.offsetTop - 8;
      this.run({ type: 'ask', page: this.page, linkText: this.linkText, history: this.history, question }, {
        onDone: (text) => this.history.push({ role: 'user', text: question }, { role: 'assistant', text }),
        retry: () => {
          bubbleEl.remove();
          this.submit(question);
        },
      });
    }

    fail(error, retry) {
      const actions = h('div', { class: 'lp-actions' });
      const box = h('div', { class: 'lp-error', role: 'alert' },
        h('div', { class: 'lp-error-msg', text: error.message || 'Something went wrong.' }),
        error.detail ? h('div', { class: 'lp-error-detail', text: String(error.detail).slice(0, 400) }) : null,
        actions);
      if (NEEDS_SETTINGS.has(error.code)) {
        const settings = h('button', { class: 'lp-btn lp-primary', type: 'button', text: 'Open settings' });
        settings.addEventListener('click', () => {
          try {
            chrome.runtime.sendMessage({ type: 'linkpeek:open-options' }).catch(() => {});
          } catch {
            // extension was reloaded
          }
        });
        actions.append(settings);
      }
      if (retry && !NO_RETRY.has(error.code)) {
        const again = h('button', { class: 'lp-btn', type: 'button', text: 'Try again' });
        again.addEventListener('click', () => {
          box.remove();
          retry();
        });
        actions.append(again);
      }
      if (!actions.childElementCount) actions.remove();
      this.body.append(box);
      box.scrollIntoView({ block: 'nearest' });
    }

    async copy() {
      const text = [this.summary || this.titleEl.textContent, `Source: ${this.page?.url || this.url}`].join('\n\n');
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        // Insecure (http) pages have no clipboard API: use the old way.
        const scratch = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
        scratch.value = text;
        this.root.append(scratch);
        scratch.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
        scratch.remove();
      }
      if (!copied) return;
      this.copyBtn.replaceChildren(icon('check'));
      this.copyBtn.classList.add('lp-ok');
      setTimeout(() => {
        this.copyBtn.replaceChildren(icon('copy'));
        this.copyBtn.classList.remove('lp-ok');
      }, 1300);
    }

    // Keys pressed while focus is inside the bubble never reach the page, so
    // typing a question cannot trigger the site's own keyboard shortcuts.
    handleKey(event) {
      event.stopPropagation();
      if (event.type !== 'keydown' || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      } else if (event.key === 'Enter' && !event.shiftKey && this.isTyping(event)) {
        event.preventDefault();
        this.submit();
      }
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      cancelAnimationFrame(this.frame);
      this.closeReputationPort();
      try {
        this.iconPort?.disconnect();
      } catch {
        // already closed
      }
      this.unmarkLink();
      try {
        this.cancel?.();
      } catch {
        // nothing to cancel
      }
      this.host.remove();
      if (bubble === this) bubble = null;
    }
  }

  function openBubble(options) {
    bubble?.close();
    bubble = new Bubble(options);
  }

  // ── Trigger: hold the key, click a link ──────────────────────────────

  function findAnchor(event) {
    for (const node of event.composedPath()) {
      if (node.nodeType !== 1) continue;
      const name = node.localName;
      if ((name === 'a' || name === 'area') && (node.hasAttribute('href') || node.hasAttribute('xlink:href'))) return node;
    }
    return null;
  }

  function linkUrl(anchor) {
    const raw = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
    if (!raw || raw.startsWith('#')) return null;
    try {
      const url = new URL(raw, anchor.baseURI);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const here = new URL(location.href);
      if (url.hash && url.origin + url.pathname + url.search === here.origin + here.pathname + here.search) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function linkLabel(anchor) {
    if (!anchor) return '';
    const text =
      anchor.textContent ||
      anchor.getAttribute('aria-label') ||
      anchor.getAttribute('title') ||
      anchor.querySelector?.('img[alt]')?.getAttribute('alt') ||
      '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function isTriggered(event) {
    if (trigger.kind === 'mod') {
      return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    }
    return held.has(trigger.code) && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  function onClick(event) {
    if (!isAlive()) return destroy();
    // isTrusted: a page must not be able to script a peek (and spend your tokens).
    if (!event.isTrusted || event.button !== 0 || !isTriggered(event)) return;
    const anchor = findAnchor(event);
    const url = anchor && linkUrl(anchor);
    if (!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openBubble({
      url,
      linkText: linkLabel(anchor),
      point: { x: event.clientX, y: event.clientY },
      rect: anchor.getBoundingClientRect(),
      anchor,
    });
  }

  // Only real, unmodified key presses arm the shortcut. Shortcuts like Cmd+X
  // must not count: macOS never sends keyup for a key released while Cmd is
  // down, which would leave it "held" forever.
  function trackKey(event) {
    if (event.isTrusted && !event.metaKey && !event.ctrlKey && !event.altKey) held.add(event.code);
  }

  function onKeyDown(event) {
    if (!isAlive()) return destroy();
    if (bubble?.owns(event)) {
      // Tracked even while typing a question: after asking one, focus is still
      // in the bubble, and holding X to peek at the next link must just work.
      trackKey(event);
      bubble.handleKey(event);
      return;
    }
    if (event.key === 'Escape' && bubble && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      bubble.close();
      return;
    }
    trackKey(event);
  }

  function onKeyUp(event) {
    if (event.key === 'Meta' || event.key === 'Control') held.clear();
    else held.delete(event.code);
    if (bubble?.owns(event)) bubble.handleKey(event);
  }

  function onKeyPress(event) {
    if (bubble?.owns(event)) bubble.handleKey(event);
  }

  // A press anywhere outside the bubble dismisses it, like any popover. (A
  // shortcut-click on another link then opens a new bubble for that link.)
  function onPointerDown(event) {
    if (bubble && event.isTrusted && event.button === 0 && !bubble.owns(event)) bubble.close();
  }

  function onContextMenu(event) {
    const anchor = findAnchor(event);
    lastContext = {
      point: { x: event.clientX, y: event.clientY },
      label: linkLabel(anchor),
      anchor,
      time: Date.now(),
    };
  }

  // "Peek at this link" in the context menu.
  function onMessage(message) {
    if (message?.type !== 'linkpeek:open' || typeof message.url !== 'string') return;
    const recent = lastContext && Date.now() - lastContext.time < 60_000 ? lastContext : null;
    // Only mark the link that was right-clicked if it is the one being opened.
    const anchor = recent?.anchor && linkUrl(recent.anchor) === message.url ? recent.anchor : null;
    openBubble({
      url: message.url,
      linkText: recent?.label || '',
      point: recent?.point,
      rect: anchor?.getBoundingClientRect(),
      anchor,
    });
  }

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    if (changes.trigger) setTrigger(changes.trigger.newValue);
    if (changes.theme) setTheme(changes.theme.newValue);
  }

  function setTheme(value) {
    theme = THEMES.has(value) ? value : 'auto';
    bubble?.applyTheme(); // an open bubble changes design on the spot
  }

  function setTrigger(value) {
    if (value?.kind === 'mod' && value.mod === 'alt') trigger = { kind: 'mod', mod: 'alt' };
    else if (value?.kind === 'key' && typeof value.code === 'string' && value.code) trigger = { kind: 'key', code: value.code };
    else trigger = DEFAULT_TRIGGER;
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }

  function destroy() {
    for (const [target, type, handler, options] of listeners.splice(0)) {
      target.removeEventListener(type, handler, options);
    }
    held.clear();
    bubble?.close();
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // the extension is gone; nothing left to detach
    }
  }

  // Capture on window: these run before the page's own handlers.
  listen(window, 'click', onClick, true);
  listen(window, 'keydown', onKeyDown, true);
  listen(window, 'keyup', onKeyUp, true);
  listen(window, 'keypress', onKeyPress, true);
  listen(window, 'pointerdown', onPointerDown, true);
  listen(window, 'contextmenu', onContextMenu, true);
  // A key released while another window had focus never sends keyup.
  listen(window, 'blur', (event) => event.target === window && held.clear(), true);
  listen(document, 'visibilitychange', () => held.clear(), false);
  listen(prefersDark, 'change', () => bubble?.applyTheme(), false); // "Auto" follows the system live

  try {
    chrome.storage.sync.get({ trigger: DEFAULT_TRIGGER, theme: 'auto' }).then((stored) => {
      setTrigger(stored.trigger);
      setTheme(stored.theme);
    }, () => {});
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    // Running without extension APIs (should not happen): the default shortcut still works.
  }

  globalThis.__linkpeek = {
    isAlive,
    destroy,
    get bubble() {
      return bubble;
    },
  };
})();
