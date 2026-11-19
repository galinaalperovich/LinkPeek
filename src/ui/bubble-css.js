// Styles for the bubble. They live in a closed shadow root, so the host page
// cannot restyle the bubble and the bubble cannot leak styles into the page.
(() => {
  'use strict';

  globalThis.LinkPeekCSS = /* css */ `
:host { all: initial; }

.lp, .lp-tip {
  /* Daylight: the default, and the fallback if no design class is set. */
  --bg: #ffffff;
  --fg: #1b1c1f;
  --strong: #1b1c1f;
  --muted: #6b6f78;
  --line: rgba(20, 22, 28, 0.1);
  --soft: #f4f4f1;
  --accent: #f5a524;
  --accent-soft: #fdf1d8;
  --accent-ink: #7a4b00;
  --on-accent: #1b1c1f;
  --marker: #f5a524;
  --bar: rgba(20, 22, 28, 0.16);
  --link: #1d5fd1;
  --danger: #b3261e;
  --ok: #2e9e5b;
  --good: #2e9e5b;
  --mid: #d9920a;
  --bad: #d0443a;
  --send-bg: #1b1c1f;
  --send-fg: #ffffff;
  --panel: var(--bg);
  --border: 1px solid var(--line);
  --radius: 14px;
  --shadow: 0 18px 50px -12px rgba(15, 18, 28, 0.38), 0 4px 14px rgba(15, 18, 28, 0.1);
  --blur: none;
  --tip-bg: #1f2024;
  --tip-fg: #ededf0;
  --tip-muted: #a9adb8;
  --tip-line: rgba(255, 255, 255, 0.14);
  --tip-shadow: 0 10px 30px -8px rgba(15, 18, 28, 0.5), 0 2px 8px rgba(15, 18, 28, 0.2);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-read: var(--font);
  --size: 13.5px;
  color-scheme: light;
}

/* Graphite: dark, same amber accent. */
.lp-t-dark {
  --bg: #1f2024;
  --fg: #e6e6e9;
  --strong: #ffffff;
  --muted: #9da1ab;
  --line: rgba(255, 255, 255, 0.11);
  --soft: #2b2c32;
  --accent-soft: #3a2f17;
  --accent-ink: #f7c66b;
  --bar: rgba(255, 255, 255, 0.2);
  --link: #8ab4ff;
  --danger: #ff8a80;
  --ok: #4cc38a;
  --good: #4cc38a;
  --mid: #f0b429;
  --bad: #ff7b72;
  --send-bg: #f5a524;
  --send-fg: #1b1c1f;
  --shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.7), 0 4px 14px rgba(0, 0, 0, 0.35);
  --tip-bg: #34363d;
  --tip-shadow: 0 10px 30px -8px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.1);
  color-scheme: dark;
}

/* Clear: safe for colour-blind readers. Blue, orange and vermilion (the
   Okabe-Ito palette) stay apart for every common type of colour blindness,
   and nothing relies on colour alone: the meter also shows its number, errors
   carry a sign, links are always underlined, borders and text are stronger. */
.lp-t-vision {
  --fg: #101216;
  --strong: #000000;
  --muted: #474d59;
  --line: rgba(16, 18, 22, 0.28);
  --soft: #edf2f8;
  --accent: #0072b2;
  --accent-soft: #d6e9f5;
  --accent-ink: #004a75;
  --on-accent: #ffffff;
  --marker: #0072b2;
  --bar: rgba(16, 18, 22, 0.25);
  --link: #0072b2;
  --danger: #b34700;
  --ok: #0072b2;
  --good: #0072b2;
  --mid: #e69f00;
  --bad: #d55e00;
  --send-bg: #0072b2;
  --border: 1.5px solid rgba(16, 18, 22, 0.55);
  --size: 14px;
}

/* Paper: a warm page set in a book face, for long reading. */
.lp-t-paper {
  --bg: #fbf6ea;
  --fg: #33291f;
  --strong: #1f1710;
  --muted: #7d6c59;
  --line: rgba(70, 48, 24, 0.17);
  --soft: #f2e8d3;
  --accent: #b4532a;
  --accent-soft: #f1dcc6;
  --accent-ink: #7c3716;
  --on-accent: #fff8ee;
  --marker: #b4532a;
  --bar: rgba(70, 48, 24, 0.2);
  --link: #8f3d16;
  --danger: #a12d1f;
  --ok: #4f7f55;
  --good: #4f7f55;
  --mid: #b8860b;
  --bad: #a8402d;
  --send-bg: #b4532a;
  --send-fg: #fff8ee;
  --border: 1px solid rgba(70, 48, 24, 0.26);
  --radius: 9px;
  --shadow: 0 18px 44px -14px rgba(60, 38, 14, 0.42), 0 3px 10px rgba(60, 38, 14, 0.12);
  --tip-bg: #33291f;
  --tip-fg: #fbf6ea;
  --tip-muted: #c9b9a2;
  --font-read: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  --size: 14.5px;
}

/* Midnight: frosted navy glass with a violet-to-cyan edge. */
.lp-t-midnight {
  --bg: #151936;
  --fg: #d9defa;
  --strong: #ffffff;
  --muted: #98a2d4;
  --line: rgba(150, 162, 255, 0.2);
  --soft: rgba(132, 144, 255, 0.14);
  --accent: #8b7bff;
  --accent-soft: rgba(139, 123, 255, 0.26);
  --accent-ink: #cfc8ff;
  --on-accent: #0b0e22;
  --marker: #38d6f2;
  --bar: rgba(170, 180, 255, 0.26);
  --link: #7dd3fc;
  --danger: #ff9bb0;
  --ok: #4ade80;
  --good: #34d399;
  --mid: #fbbf24;
  --bad: #fb7185;
  --send-bg: linear-gradient(135deg, #8b7bff, #38d6f2);
  --send-fg: #0b0e22;
  --panel: linear-gradient(165deg, rgba(27, 32, 68, 0.9), rgba(13, 16, 38, 0.93));
  --border: 1px solid rgba(150, 162, 255, 0.3);
  --radius: 16px;
  --shadow: 0 26px 70px -18px rgba(70, 58, 220, 0.62), 0 6px 18px rgba(4, 6, 20, 0.5);
  --blur: blur(18px) saturate(160%);
  --tip-bg: #0c0f26;
  --tip-fg: #e3e7ff;
  --tip-muted: #98a2d4;
  --tip-line: rgba(150, 162, 255, 0.24);
  --tip-shadow: 0 14px 36px -10px rgba(40, 30, 160, 0.7), 0 0 0 1px rgba(150, 162, 255, 0.28);
  color-scheme: dark;
}

.lp {
  position: fixed;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 420px;
  max-width: calc(100vw - 16px);
  background: var(--panel);
  -webkit-backdrop-filter: var(--blur);
  backdrop-filter: var(--blur);
  color: var(--fg);
  border: var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  font: 400 var(--size)/1.5 var(--font);
  letter-spacing: normal;
  text-align: left;
  overflow: hidden;
  pointer-events: auto;
  animation: lp-in 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* Midnight's glowing top edge. */
.lp-t-midnight.lp::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: linear-gradient(90deg, #8b7bff, #38d6f2 50%, #8b7bff);
  pointer-events: none;
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

/* A real site icon sits on a white tile, so dark icons stay visible in dark designs. */
.lp-avatar.lp-has-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  box-shadow: inset 0 0 0 1px rgba(20, 22, 28, 0.1);
}
.lp-favicon { display: block; width: 18px; height: 18px; border-radius: 3px; }

.lp-titles { flex: 1; min-width: 0; }

.lp-title {
  display: block;
  color: var(--strong);
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
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.35;
  white-space: nowrap;
}
.lp-host, .lp-facts { overflow: hidden; text-overflow: ellipsis; }
/* A long site name gives way first, so the meter and reading time stay readable. */
.lp-host { flex: 0 1 auto; min-width: 48px; }
/* Never shrunk (even a sliver would cut it with an ellipsis), only capped. */
.lp-facts { flex: 0 0 auto; max-width: 72%; }

/* Source reputation: five rising bars and one word. */
.lp-rep {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 1px 7px 1px 6px;
  border: 0;
  border-radius: 999px;
  background: var(--soft);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  cursor: help;
  animation: lp-fade 0.25s ease-out;
}
.lp-rep[hidden] { display: none; }
.lp-rep:hover { filter: brightness(0.97); }
.lp-rep:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.lp-rep-good { --rep: var(--good); }
.lp-rep-mid { --rep: var(--mid); }
.lp-rep-bad { --rep: var(--bad); }
.lp-rep-none { --rep: var(--muted); color: var(--muted); font-weight: 500; }
.lp-meter { display: inline-flex; align-items: flex-end; gap: 2px; height: 10px; }
.lp-meter i { width: 3px; border-radius: 1.5px; background: var(--bar); }
.lp-meter i.on { background: var(--rep); }
.lp-meter i:nth-child(1) { height: 4px; }
.lp-meter i:nth-child(2) { height: 5.5px; }
.lp-meter i:nth-child(3) { height: 7px; }
.lp-meter i:nth-child(4) { height: 8.5px; }
.lp-meter i:nth-child(5) { height: 10px; }
/* The level as a number. Shown in the Clear design, where colour must not be the only signal. */
.lp-rep-score { display: none; color: var(--muted); font-weight: 600; }
.lp-t-vision .lp-rep-score { display: inline; }
.lp-t-vision .lp-rep { box-shadow: inset 0 0 0 1px var(--line); }
.lp-t-paper .lp-rep { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }

/* Hover card that explains the meter. Outside .lp, so it carries its own colours. */
.lp-tip {
  position: fixed;
  z-index: 1;
  box-sizing: border-box;
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--tip-bg);
  color: var(--tip-fg);
  box-shadow: var(--tip-shadow);
  font: 400 12px/1.45 var(--font);
  letter-spacing: normal;
  text-align: left;
  white-space: normal;
  pointer-events: none;
  animation: lp-fade 0.12s ease-out;
}
.lp-tip[hidden] { display: none; }
.lp-tip-title { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.lp-tip-title strong { font-weight: 650; }
.lp-tip-title span { flex: none; color: var(--tip-muted); font-size: 11px; }
.lp-tip-foot { margin-top: 3px; padding-top: 6px; border-top: 1px solid var(--tip-line); color: var(--tip-muted); font-size: 11px; }
@keyframes lp-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.lp-credit {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lp-credit strong { color: var(--strong); font-weight: 650; }

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
.lp-icon.lp-ok { color: var(--ok); }

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

.lp-md { font-family: var(--font-read); }
.lp-md > :first-child { margin-top: 0; }
.lp-md > :last-child { margin-bottom: 8px; }
.lp-md p { margin: 0 0 8px; }
.lp-md ul, .lp-md ol { margin: 0 0 8px; padding-left: 20px; }
.lp-md li { margin: 3px 0; padding-left: 2px; }
.lp-md li::marker { color: var(--marker); font-weight: 700; }
.lp-md ol > li::marker { color: var(--muted); font-weight: 600; }
.lp-md li > ul, .lp-md li > ol { margin: 3px 0 0; }
.lp-md strong { color: var(--strong); font-weight: 680; }
.lp-md h3, .lp-md h4, .lp-md h5 { margin: 12px 0 4px; color: var(--strong); font-size: 1em; font-weight: 700; line-height: 1.35; }
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

/* Design-specific touches. */
.lp-t-paper .lp-head { border-bottom: 3px double var(--line); }
.lp-t-paper .lp-title { font-family: var(--font-read); font-size: 15.5px; font-weight: 700; }
.lp-t-paper .lp-q { font-family: var(--font-read); font-style: italic; border-radius: 6px; }
.lp-t-paper .lp-md li::marker { font-weight: 400; }
.lp-t-vision .lp-md a, .lp-t-vision .lp-linkbtn { text-decoration-thickness: 2px; }
.lp-t-vision .lp-error-msg::before { content: "⚠ "; }
.lp-t-vision .lp-input, .lp-t-vision .lp-btn { border-width: 1.5px; border-color: rgba(16, 18, 22, 0.5); }
.lp-t-vision :focus-visible { outline-width: 3px !important; }
.lp-t-midnight .lp-head { background: linear-gradient(180deg, rgba(139, 123, 255, 0.12), transparent); }
.lp-t-midnight .lp-input { background: rgba(8, 10, 28, 0.45); }
.lp-t-midnight .lp-q { background: linear-gradient(135deg, rgba(139, 123, 255, 0.3), rgba(56, 214, 242, 0.18)); color: var(--strong); }
.lp-t-midnight .lp-avatar:not(.lp-has-icon) { background: linear-gradient(135deg, #8b7bff, #38d6f2); color: #0b0e22; }
.lp-linkbtn {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--link);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.lp-linkbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

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
.lp-btn.lp-primary { border-color: transparent; background: var(--accent); color: var(--on-accent); }
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
  background: var(--send-bg);
  color: var(--send-fg);
  cursor: pointer;
}
.lp-send:disabled { opacity: 0.35; cursor: default; }
.lp-send:not(:disabled):hover { filter: brightness(1.2); }

@media (prefers-reduced-motion: reduce) {
  .lp, .lp-dots i, .lp-skeleton i, .lp-rep, .lp-tip { animation: none; }
}
`;
})();
