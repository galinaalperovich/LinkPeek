// Styles for the bubble. They live in a closed shadow root, so the host page
// cannot restyle the bubble and the bubble cannot leak styles into the page.
(() => {
  'use strict';

  globalThis.LinkPeekCSS = /* css */ `
:host { all: initial; }

.lp {
  --bg: #ffffff;
  --fg: #1b1c1f;
  --muted: #6b6f78;
  --line: rgba(20, 22, 28, 0.1);
  --soft: #f4f4f1;
  --accent: #f5a524;
  --accent-soft: #fdf1d8;
  --accent-ink: #7a4b00;
  --link: #1d5fd1;
  --danger: #b3261e;
  --shadow: 0 18px 50px -12px rgba(15, 18, 28, 0.38), 0 4px 14px rgba(15, 18, 28, 0.1);

  position: fixed;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 420px;
  max-width: calc(100vw - 16px);
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  font: 400 13.5px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  letter-spacing: normal;
  text-align: left;
  overflow: hidden;
  pointer-events: auto;
  color-scheme: light;
  animation: lp-in 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
}

@media (prefers-color-scheme: dark) {
  .lp {
    --bg: #1f2024;
    --fg: #ececee;
    --muted: #9da1ab;
    --line: rgba(255, 255, 255, 0.11);
    --soft: #2b2c32;
    --accent-soft: #3a2f17;
    --accent-ink: #f7c66b;
    --link: #8ab4ff;
    --danger: #ff8a80;
    --shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.7), 0 4px 14px rgba(0, 0, 0, 0.35);
    color-scheme: dark;
  }
}

@keyframes lp-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}

.lp *, .lp *::before, .lp *::after { box-sizing: border-box; }

/* ── Header ─────────────────────────────────────────────── */

.lp-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 8px 10px 12px;
  border-bottom: 1px solid var(--line);
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.lp-head.lp-dragging { cursor: grabbing; }

.lp-avatar {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 700;
  font-size: 13px;
  line-height: 26px;
  text-align: center;
  text-transform: uppercase;
}

.lp-titles { flex: 1; min-width: 0; }

.lp-title {
  display: block;
  color: var(--fg);
  font-weight: 650;
  line-height: 1.3;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.lp-title:hover { text-decoration: underline; }

.lp-sub {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lp-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  text-decoration: none;
}
.lp-icon:hover { background: var(--soft); color: var(--fg); }
.lp-icon:focus-visible, .lp-btn:focus-visible, .lp-send:focus-visible, .lp-title:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lp-icon.lp-ok { color: #2e9e5b; }

/* ── Body ───────────────────────────────────────────────── */

.lp-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 60px;
  padding: 12px 14px 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
  user-select: text;
  -webkit-user-select: text;
  cursor: auto;
  overflow-wrap: anywhere;
}

.lp-md > :first-child { margin-top: 0; }
.lp-md > :last-child { margin-bottom: 8px; }
.lp-md p { margin: 0 0 8px; }
.lp-md ul, .lp-md ol { margin: 0 0 8px; padding-left: 20px; }
.lp-md li { margin: 3px 0; padding-left: 2px; }
.lp-md li::marker { color: var(--accent); font-weight: 700; }
.lp-md ol > li::marker { color: var(--muted); font-weight: 600; }
.lp-md li > ul, .lp-md li > ol { margin: 3px 0 0; }
.lp-md strong { font-weight: 680; }
.lp-md h3, .lp-md h4, .lp-md h5 { margin: 12px 0 4px; font-size: 13.5px; font-weight: 700; line-height: 1.35; }
.lp-md h5 { color: var(--muted); }
.lp-md a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.lp-md code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--soft);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.lp-md pre { margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: var(--soft); overflow-x: auto; }
.lp-md pre code { padding: 0; background: none; white-space: pre; }
.lp-md blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); }
.lp-md hr { margin: 10px 0; border: 0; border-top: 1px solid var(--line); }

.lp-q {
  width: fit-content;
  max-width: 88%;
  margin: 10px 0 10px auto;
  padding: 6px 11px;
  border-radius: 13px 13px 4px 13px;
  background: var(--soft);
  white-space: pre-wrap;
}

.lp-note { margin: 0 0 8px; color: var(--muted); font-size: 12px; }

.lp-status { display: flex; align-items: center; gap: 8px; margin: 2px 0 10px; color: var(--muted); font-size: 12.5px; }
.lp-status[hidden], .lp-skeleton[hidden] { display: none; }
.lp-dots { display: inline-flex; gap: 3px; }
.lp-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: lp-dot 1.1s infinite ease-in-out; }
.lp-dots i:nth-child(2) { animation-delay: 0.15s; }
.lp-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes lp-dot {
  0%, 70%, 100% { opacity: 0.25; transform: translateY(0); }
  35% { opacity: 1; transform: translateY(-2px); }
}

.lp-skeleton { display: grid; gap: 9px; margin: 4px 0 14px; }
.lp-skeleton i {
  height: 10px;
  border-radius: 5px;
  background: linear-gradient(90deg, var(--soft) 25%, var(--line) 50%, var(--soft) 75%);
  background-size: 300% 100%;
  animation: lp-shimmer 1.4s infinite linear;
}
.lp-skeleton i:nth-child(1) { width: 92%; }
.lp-skeleton i:nth-child(2) { width: 78%; }
.lp-skeleton i:nth-child(3) { width: 85%; }
.lp-skeleton i:nth-child(4) { width: 52%; }
@keyframes lp-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -50% 0; }
}

.lp-error { margin: 2px 0 10px; }
.lp-error-msg { color: var(--danger); font-weight: 600; }
.lp-error-detail { margin-top: 3px; color: var(--muted); font-size: 12px; }
.lp-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }

.lp-btn {
  margin: 0;
  padding: 5px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.lp-btn:hover { background: var(--soft); }
.lp-btn.lp-primary { border-color: transparent; background: var(--accent); color: #1b1c1f; }
.lp-btn.lp-primary:hover { filter: brightness(1.05); background: var(--accent); }

/* ── Ask ────────────────────────────────────────────────── */

.lp-ask {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 0;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--line);
}

.lp-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  max-height: 96px;
  margin: 0;
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  line-height: 1.4;
  resize: none;
  outline: none;
  overflow-y: auto;
  scrollbar-width: thin;
}
.lp-input::placeholder { color: var(--muted); opacity: 0.85; }
.lp-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.lp-input:disabled { background: var(--soft); cursor: not-allowed; }

.lp-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: var(--fg);
  color: var(--bg);
  cursor: pointer;
}
.lp-send:disabled { opacity: 0.3; cursor: default; }
.lp-send:not(:disabled):hover { filter: brightness(1.2); }

@media (prefers-reduced-motion: reduce) {
  .lp, .lp-dots i, .lp-skeleton i { animation: none; }
}
`;
})();
