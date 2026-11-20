# Chrome Web Store listing

Everything to paste into the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole), in the order the dashboard asks for it. The images are in this folder; regenerate them with `npm run store`.

## Before you submit

1. Check the name. Search the store for "LinkPeek" and similar names. If you rename, change `name` and `short_name` in `manifest.json`.
2. Build the package: `npm run zip`. It writes `linkpeek-<version>.zip` with only what the extension needs (manifest, icons, `src/`, license).
3. Register as a developer in the dashboard if you have not (a one-time US$5 fee, paid to Google).
4. Click **New item**, upload the zip, then fill in the tabs below.
5. Paste the short test instructions; see [Test instructions](#test-instructions).
6. Submit for review. Extensions that ask for access to all sites get a closer review, so allow extra time.

After it is published, replace the "Install in 2 minutes" section of the README with the store link.

## Store listing tab

**Title** (from the manifest)

```
LinkPeek — Peek at any link. Skip the new tab.
```

**Summary** (from the manifest, 132 characters at most)

```
Every new tab breaks your focus. Hold X and click a link for an AI summary in a bubble, then ask follow-ups. No tab opened.
```

**Description**

```
Hold X and click any link. A small bubble opens next to it with a summary of the page behind the link, and a box to ask follow-up questions. You never leave the page you are reading.

WHAT IT DOES
• Keyless or your own key: you choose. Keyless needs no API key. Summaries are made by Chrome's built-in AI on your own computer: free, offline, and the page is not sent to any AI service. (Needs Chrome 138 or later on a computer that can run Chrome's built-in AI.)
• Summarizes the linked page in place. The page is read in the background and the summary streams into a bubble beside the link. The link is highlighted while its bubble is open, so it is always clear what the bubble is about.
• Answers your questions about that page, keeping the conversation in context.
• Shows who is talking: the author or publishing organization, the date, and a five-bar reputation meter for the source. Hover over the meter to see what the rating means and why. The rating is an estimate made by the AI, not a verified score.
• Remembers. Peek at the same page again and the saved summary appears at once, as long as the page has not changed.
• Works on pages that need JavaScript, and on PDFs when you use your own key.
• Five designs: Light, Dark, Color-blind safe, Paper and Midnight.
• Your format. With your own key, one plain-language prompt controls length, bullets or prose, language and tone.

HOW TO USE IT
1. After installing, the settings page opens with two choices: Keyless and Your key. If Keyless says "Ready", there is nothing to set up. If it says "One step left", Chrome still has to download its AI model (about 4 GB, once): that starts with your first click on that page or your first peek. Or choose Your key and paste a Claude or OpenAI key.
2. On any page, hold X and click a link. Or right-click a link and choose "Peek at this link".
3. Read the summary, ask a question, press Esc to close.
You can change the X key to any letter or digit in the settings.

KEYLESS, OR YOUR OWN KEY
Keyless uses the AI model that ships with Chrome. It runs on your computer and costs nothing. It is a small model: good for a quick gist in one set format (a TL;DR and key points), in English, Spanish, Japanese, German or French, and it reads about the first 4,000 to 6,000 words of a page. Chrome downloads the model once (about 4 GB); after that the first summary of a session takes 10 to 30 seconds while the model wakes up.
Your key gives sharper summaries in any format you describe and almost any language, reads long pages and PDFs, and rates sources more reliably. Paste your own Claude (Anthropic) or OpenAI API key; LinkPeek then talks directly to that provider, which bills you for what you use: between a fraction of a cent and a few cents per summary, depending on the model you choose.
The choice is yours and LinkPeek never switches by itself. Either way, it has no server, no account and no subscription.

SMALL AND EASY TO TRUST
• Zero dependencies and no remote code: everything it runs is in the package, under 100 KB.
• Open source, with no build step. The code you can read on GitHub is the code that runs.

PRIVACY
• In Keyless mode, the page text is not sent to anyone: the summary is made on your computer.
• With your key, the key is stored on your device only and is sent only to the provider it belongs to. The text of a page is sent to that provider only when you peek at it.
• Nothing is sent anywhere else. There is no analytics and no tracking.
• Summaries are kept on your device so repeat peeks are instant. You can clear them in the settings.

LinkPeek is open source: https://github.com/galinaalperovich/LinkPeek
```

**Category:** Tools

**Language:** English

**Store icon:** `icons/icon-128.png`

**Screenshots** (1280×800, in this order)

| File | Shows |
| --- | --- |
| `screenshots/1-summary.jpg` | A summary bubble next to the clicked link |
| `screenshots/2-ask.jpg` | A follow-up question answered in the bubble |
| `screenshots/3-reputation.jpg` | The reputation meter's explanation on hover |
| `screenshots/4-dark.jpg` | Dark mode |
| `screenshots/5-settings.jpg` | The settings page |

**Small promo tile** (440×280): `promo-small.jpg`

**Marquee promo tile** (1400×560, optional): `promo-marquee.jpg`

**Homepage URL:** `https://github.com/galinaalperovich/LinkPeek`

**Support URL:** `https://github.com/galinaalperovich/LinkPeek/issues`

## Privacy tab

**Single purpose**

```
LinkPeek shows an AI-generated summary of a linked web page in a bubble on the current page, and answers the user's questions about that linked page, so the user does not have to open the link.
```

**Permission justifications**

`storage`

```
Saves the user's preferences: the summary format prompt, the chosen model, the shortcut key and whether the reputation meter is shown.
```

`scripting`

```
When a linked page only renders its content with JavaScript, LinkPeek opens it in a background tab and uses the scripting API to read the rendered text of that tab, then closes the tab. It is used only on the page the user asked to summarize.
```

`offscreen`

```
The extension's service worker has no DOM. An offscreen document parses the HTML of the linked page (DOMParser) to extract its readable text, and runs Chrome's built-in AI (the Prompt API, which is not available in service workers) to summarize that text on the user's device when the user has chosen the "Keyless" mode. The offscreen document makes no network requests and runs no page scripts.
```

`contextMenus`

```
Adds one item, "Peek at this link", to the context menu of links, as an alternative to the keyboard shortcut.
```

Host permissions (`http://*/*`, `https://*/*`, and the content script on `file:///*`)

```
The user can ask for a summary of any link on any page, so LinkPeek needs to (1) notice the shortcut click on whatever page the user is reading, and (2) fetch the linked page, which can be on any site. Pages are fetched only when the user triggers a peek on a specific link. The extension also calls the API of the AI provider the user configured (api.anthropic.com, api.openai.com, or a base URL the user enters). Local file pages are matched so the shortcut also works on HTML files the user opens from disk; Chrome keeps this off until the user turns on "Allow access to file URLs". The content script runs in all frames of a page, so that links inside embedded pages (document viewers, widgets) can be peeked at in the same way; it does the same thing in a frame as in the page itself.
```

**Are you using remote code?**

```
No. All JavaScript is included in the package. The extension loads no scripts from the network and uses no eval.
```

**Data usage: what the extension handles**

Tick these two; leave the rest unticked.

- **Authentication information.** The user's own AI provider API key. Stored on the device, sent only to that provider as the credential.
- **Website content.** The text of a page the user chose to summarize is sent to the user's AI provider to produce the summary. Summaries are saved on the device.

Not collected: personally identifiable information, health, financial, personal communications, location, web history, user activity.

Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**

```
https://galinaalperovich.github.io/LinkPeek/privacy.html
```

## Distribution tab

- **Payments:** Free of charge.
- **Visibility:** Public.
- **Regions:** All regions.

## Test instructions

The dashboard's **Test instructions** field takes 500 characters at most. Paste this (464 characters):

```
Two modes, chosen in settings. Keyless (default where Chrome 138+ can run its built-in AI): if it says "One step left", click the settings page to start the one-time model download and wait for "Ready". Your key: choose "Your key" and paste an Anthropic or OpenAI key. Then on any article, hold X and click a link: a summary bubble opens (the first Keyless one takes 10-30 s). Ask a question in the box; Esc closes it. Hover the bar meter to see the source rating.
```

On a computer that can run Chrome's built-in AI the reviewer needs no key. For reviewers on other machines you can offer a key in the dashboard's separate test account fields: create a new key with a low spending limit just for the review, and delete it once the review is done.
