<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.png">
    <img alt="LinkPeek. Peek at any link. Keep your focus. Every new tab breaks your concentration. Hold X, click a link, read the gist in place." src="docs/hero-light.png">
  </picture>
</h1>

**A Chrome extension for staying focused. Opening a link in a new tab costs you your train of thought.<br>Hold <kbd>X</kbd> and click it instead: an AI summary opens in a bubble right where you are, and answers your questions.**

[![CI](https://img.shields.io/github/actions/workflow/status/galinaalperovich/LinkPeek/test.yml?branch=main&style=flat-square&label=CI)](https://github.com/galinaalperovich/LinkPeek/actions/workflows/test.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-555555?style=flat-square)](LICENSE)
[![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=flat-square)](manifest.json)
[![No dependencies](https://img.shields.io/badge/dependencies-none-2e9e5b?style=flat-square)](#development)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-coming%20soon-bf8a1f?style=flat-square)](#install)

**[Chrome Web Store (coming soon)](#install) · [Privacy](PRIVACY.md) · [Store listing kit](store/listing.md)**

[Install](#install) · [Use](#use) · [Designs](#designs) · [Settings](#settings) · [How a page is read](#how-a-page-is-read) · [Privacy](#privacy-and-security) · [Cost](#cost) · [Development](#development)

<code>git clone https://github.com/galinaalperovich/LinkPeek.git</code>

<br><br>

<img src="docs/demo.gif" alt="On the Playwright repository on GitHub, the pointer goes to the Documentation link, X is held and the link is clicked. The link is highlighted, a bubble opens under it and a summary of playwright.dev streams in. Hovering the reputation meter explains the rating. A question is typed and answered in the bubble." width="900">

<sub>Recorded on github.com with <code>npm run demo</code>. The page, the link, the icon and the bubble are real. The summary's words are replayed by a local stand-in for the API, so the recording needs no key.</sub>

</div>

<br>

LinkPeek uses your own Claude (Anthropic) or OpenAI API key. It has no server of its own, no account and no tracking.

- **Summarizes the link, in place.** The page is read in the background and the summary streams into a bubble beside the link. The link is highlighted while its bubble is open, so you always see what the bubble is about.
- **Answers questions.** Type in the bubble to ask anything about the linked page. The conversation keeps its context.
- **Shows who is talking.** The header carries the site's own icon, the author or publishing organization, the date, and a five-bar reputation meter for the source.
- **Remembers.** Peek at the same page again and the saved summary appears at once, with no new request, as long as the page has not changed.
- **Five designs.** Light, Dark, Color-blind safe, Paper and Midnight, or Auto to follow your system.
- **Your format.** One plain-language prompt controls length, bullets or prose, language and tone.
- **Reads what a plain fetch cannot.** Pages that need JavaScript are opened in a muted background tab, read, and closed again. PDFs are sent to the model as documents.
- **One key.** Paste a Claude or an OpenAI key; LinkPeek tells them apart on its own.

---

## Install

The Chrome Web Store version is on its way. Until then, installing takes two minutes and no programming. Do these six steps in order.

**1. Download LinkPeek.**
Click this link: **[Download LinkPeek](https://github.com/galinaalperovich/LinkPeek/archive/refs/heads/main.zip)**.
A file named `LinkPeek-main.zip` appears in your Downloads folder.

**2. Unzip it.**
Double-click that file. You now have a folder named `LinkPeek-main`.
Keep this folder. If you delete it, LinkPeek stops working.

**3. Open the extensions page in Chrome.**
Click the address bar at the top of Chrome, type `chrome://extensions` and press Enter.

**4. Turn on "Developer mode".**
It is a small switch in the top-right corner of that page. Click it once so it turns blue.

**5. Click "Load unpacked".**
The button is in the top-left corner. A file window opens. Pick the `LinkPeek-main` folder and click **Select**.

**6. Paste your key.**
A LinkPeek page opens by itself. Paste your key into the box at the top.
When a green **✓ key works** appears under the box, you are done.

**Now try it:** open any website, hold down the <kbd>X</kbd> key, and click a link.

Prefer the terminal? Clone instead of downloading, then do steps 3 to 6 with the cloned folder:

```bash
git clone https://github.com/galinaalperovich/LinkPeek.git
```

### I do not have a key

A key is a long password that lets LinkPeek use an AI for you. You need one, from either company:

- **Claude:** open [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys), sign up, click **Create Key**, copy it.
- **OpenAI:** open [platform.openai.com/api-keys](https://platform.openai.com/api-keys), sign up, click **Create new secret key**, copy it.

Both ask for a payment card. Each summary costs between a fraction of a cent and a few cents, depending on the model you pick; see [Cost](#cost).

### It does not work

- **Nothing happens when I click.** Keep <kbd>X</kbd> held down *while* you click the link. If it still does nothing, reload the page and try again.
- **It works on some pages but not on others.** Chrome does not let any extension run on its own pages (the new-tab page, settings, the Chrome Web Store).
- **The bubble shows an error about the key.** Click the puzzle-piece icon at the top right of Chrome, click **LinkPeek**, and paste the key again.
- **I want to change the X key or the look.** Same place: puzzle-piece icon, then **LinkPeek**. Every bubble also has a small **Settings** link at the bottom.

LinkPeek needs Chrome 116 or later. Other Chromium browsers (Edge, Brave) should work but are untested.

## Use

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/bubble-dark.png">
  <img src="docs/bubble-light.png" alt="A LinkPeek bubble under a highlighted link, with a summary and a follow-up question answered below it" width="760">
</picture>

| Do this | To |
| --- | --- |
| Hold <kbd>X</kbd> and click a link | Peek at it |
| Right-click a link, then **Peek at this link** | Same, without the keyboard |
| Type in the bubble, <kbd>Enter</kbd> | Ask about the page (<kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line) |
| Click anywhere else, <kbd>Esc</kbd> or × | Close the bubble |
| Drag the bubble's header | Move it out of the way |
| Click the title or ↗ | Open the page in a new tab after all |
| Hover over the title | Read it in full, with the address |
| Hover over the reputation meter | See what the rating means and why the source got it |
| Click **Summarize again** under a saved summary | Get a fresh summary instead of the saved one |

While an answer is streaming, the send button turns into a stop button.

If <kbd>X</kbd> clashes with a site's own keyboard shortcuts, pick another key in the settings.

### The reputation meter

<img src="docs/reputation.png" alt="Hovering the reputation meter explains the rating" width="444">

Next to the site name, five bars and one word (Very high, High, Mixed, Low, Very low, or Unknown) say how far the publisher and author can generally be trusted. Hover over it for what the word means, why this source got it, and who decided. It is **the AI's estimate from its general knowledge, not a verified rating**: treat it as a prompt to think, not a verdict. The model is asked about the source only (site, publisher, author, title), never about what the page argues, and it is told to answer "Unknown" rather than guess. Ratings are asked once per source and remembered until you close the browser. You can switch the meter off under Advanced in the settings.

### Saved summaries

When a summary finishes, LinkPeek saves it on your device under a fingerprint (a SHA-256 hash) of the page's content, your format prompt and the model. The next time you peek at that link, the page is fetched again and fingerprinted; if nothing changed, the saved summary is shown at once and the model is not called. If the page, the format or the model changed, you get a new summary. Saved summaries are kept for 30 days, at most 300 of them, never from incognito windows, and can be cleared under Advanced in the settings.

### Local files

To use LinkPeek on a page you opened from disk (`file://…`), open `chrome://extensions`, click **Details** on LinkPeek, turn on **Allow access to file URLs**, and reload the page. Chrome keeps this off for every extension until you allow it.

## Designs

![The five designs: Light, Dark, Color-blind safe, Paper, Midnight](docs/themes.png)

Pick one in the settings, or leave it on **Auto** to follow your system's light or dark mode. An open bubble changes design on the spot.

| Design | What it is |
| --- | --- |
| **Light** | Clean white with an amber accent |
| **Dark** | Graphite with the same amber |
| **Color-blind safe** | Blue and orange in place of red and green. The reputation level is also shown as a number, links are always underlined, errors carry a warning sign, and borders, text and focus rings are stronger |
| **Paper** | A warm page with the summary set in a book typeface |
| **Midnight** | Frosted navy glass with a violet-to-cyan edge |

## Settings

Click the LinkPeek toolbar icon.

<img src="docs/settings.png" alt="LinkPeek settings" width="560">

- **API key.** Checked against the provider as soon as you paste it.
- **Model.** Defaults to Claude Opus 5.5 or GPT-6.2 Sol. Pick a smaller model for faster, cheaper peeks. The list also shows every model your key can use.
- **Summary format.** The prompt that shapes every summary. For example: `Three bullets, then one sentence on why it matters. Always answer in English.` Edit it and press **Save**; the button lights up while there are unsaved changes and confirms with a green ✓. Choosing a preset applies it at once.
- **Design.** One of the five looks above, or Auto.
- **Shortcut.** Press **Change key**, then the letter or digit you want to hold instead of <kbd>X</kbd> (<kbd>Alt</kbd>/<kbd>Option</kbd> works too).
- **Advanced.** The reputation meter on or off, how many summaries are saved (with a Clear button), and a custom API base URL for proxies and OpenAI-compatible servers such as OpenRouter or a local Ollama (`http://localhost:11434/v1`).

The key, model, design, shortcut and advanced options are saved as soon as you change them; a green "✓ Saved" appears in the corner of the card each time.

## How a page is read

1. The service worker fetches the link in the background, with your cookies, so pages you are signed in to work.
2. HTML is turned into clean text: navigation, footers, sidebars, scripts and hidden elements are dropped; headings, lists and code are kept. If the page ships its article as structured data, that is used when the visible markup is thin.
3. If that yields almost nothing (a JavaScript app, a bot check), the link is opened in a muted background tab, read once it has rendered, and the tab is closed. Your current tab stays in front the whole time.
4. PDFs up to 15 MB are sent to the model as documents. Plain text, Markdown and JSON are sent as they are.

Very long pages are cut at 100,000 characters (about 16,000 words); the bubble says so when it happens.

## Privacy and security

- Your API key is stored on your device, in the extension's own database, which web pages and the script LinkPeek runs inside them cannot read. It is sent only to the API it belongs to (or to the base URL you set).
- The text of a page you peek at is sent to your model provider, and so are the site name, author and title for the reputation meter. Nothing is sent anywhere else, and nothing is sent until you trigger a peek.
- The bubble lives in a closed shadow root: the page you are on cannot read a summary of some other site.
- Summaries are rendered without `innerHTML`, so nothing a page or a model writes can become markup or script.
- A page cannot trigger a peek by scripting clicks; only real key presses and clicks count.

More detail in [PRIVACY.md](PRIVACY.md). The permissions, and why each is needed:

| Permission | Why |
| --- | --- |
| Access to all sites | A link can point anywhere, and the click has to be noticed on any page |
| Local files (off until you allow it) | Use LinkPeek on pages opened from disk; see [Local files](#local-files) |
| `scripting` | Read the rendered text of a page opened in a background tab |
| `offscreen` | Parse fetched HTML and decode site icons (service workers have no DOM) |
| `storage` | Save your preferences |
| `contextMenus` | The **Peek at this link** menu item |

## Cost

Every peek sends the page text to your provider and is billed to your key. A typical article is roughly 2,000 to 8,000 input tokens plus a short reply; the longest page LinkPeek will send is about 25,000. Peeking at an unchanged page again is free: the saved summary is reused. With Claude, follow-up questions about the same page reuse the prompt cache. The reputation meter adds one very small request (a few hundred tokens) the first time you peek at a source in a browser session. If you peek a lot, choose a smaller model in the settings (Claude Haiku 5.5, GPT-6 Luna).

## Limitations

- Links inside iframes are not picked up.
- On a local `file://` page, links to web pages work; links to other local files do not.
- The author and date come from the page's own metadata. Pages that do not state them get no credit line.
- Pages that change a little on every load (view counts, "3 minutes ago") never match a saved summary, so they are summarized fresh each time.
- Videos are summarized from the text on their page (title, description, comments), not from the audio.
- Sites that block automated access may only show their "are you human" page.
- Holding a letter key types it into a focused text box. That is harmless, but it is one more reason the shortcut key is configurable.
- Chrome's own pages (`chrome://`, the Web Store) do not allow extensions.

## Development

Plain JavaScript, no bundler, no runtime dependencies. Edit a file, press the reload button on `chrome://extensions`, and it is live.

```
manifest.json
src/
  background.js        service worker: summarize, ask, reputation and icon requests
  content.js           the X+click trigger and the bubble UI
  ui/bubble-css.js     bubble styles and the five designs
  lib/page-loader.js   fetch, background-tab fallback, PDFs, site icons
  lib/extract.js       document to readable text
  lib/providers.js     Claude and OpenAI streaming adapters
  lib/prompts.js       system prompt and message layout
  lib/reputation.js    source reputation: prompt, parsing, what is rateable
  lib/summary-cache.js saved summaries, keyed by a hash of content, format and model
  lib/markdown.js      safe Markdown renderer
  lib/settings.js      defaults and storage
  options/             settings page, also the toolbar popup
  offscreen/           hidden page that parses HTML and decodes icons for the service worker
test/
  unit/                logic tests, no browser needed
  e2e/                 the real extension in Chromium against mock APIs
scripts/
  record-demo.mjs      records docs/demo.gif on a real website
store/                 Chrome Web Store listing text, screenshots and promo tiles
```

```bash
npm test                 # unit tests (Node 20+, nothing to install)
npm install              # once, for everything below
npx playwright install chromium
npm run test:e2e         # loads the extension into Chromium and drives it
HEADED=1 npm run test:e2e   # watch it run
SHOTS=1 npm run test:e2e    # also refresh the pictures in docs/
npm run demo             # re-record docs/demo.gif (needs network and ffmpeg)
npm run store            # refresh the store screenshots and promo tiles in store/
npm run zip              # package for the Chrome Web Store: linkpeek-<version>.zip
```

The end-to-end test starts a local server with fixture pages and stand-ins for the Claude and OpenAI APIs. It needs no API key and sends nothing off your machine. CI runs both suites on every push and pull request.

Publishing to the Chrome Web Store: the listing text, permission justifications and images are in [store/](store/listing.md).

Issues and pull requests are welcome. Please run both test suites before sending a change.

## License

[MIT](LICENSE)
