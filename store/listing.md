# Chrome Web Store listing

Everything to paste into the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole), in the order the dashboard asks for it. The images are in this folder; regenerate them with `npm run store`.

## Before you submit

1. Check the name. Search the store for "LinkPeek" and similar names. If you rename, change `name` and `short_name` in `manifest.json`.
2. Build the package: `npm run zip`. It writes `linkpeek-<version>.zip` with only what the extension needs (manifest, icons, `src/`, license).
3. Register as a developer in the dashboard if you have not (a one-time US$5 fee, paid to Google).
4. Click **New item**, upload the zip, then fill in the tabs below.
5. Decide how the reviewer will test it; see [Test instructions](#test-instructions).
6. Submit for review. Extensions that ask for access to all sites get a closer review, so allow extra time.

After it is published, replace the "Install in 2 minutes" section of the README with the store link.

## Store listing tab

**Title** (from the manifest)

```
LinkPeek — AI link summaries
```

**Summary** (from the manifest, 132 characters at most)

```
Hold X and click any link for an AI summary in a bubble, then ask follow-up questions. You never leave the page.
```

**Description**

```
Hold X and click any link. A small bubble opens next to it with a summary of the page behind the link, and a box to ask follow-up questions. You never leave the page you are reading.

WHAT IT DOES
• Summarizes the linked page in place. The page is read in the background and the summary streams into a bubble beside the link. The link is highlighted while its bubble is open, so it is always clear what the bubble is about.
• Answers your questions about that page, keeping the conversation in context.
• Shows who is talking: the author or publishing organization, the date, and a five-bar reputation meter for the source. Hover over the meter to see what the rating means and why. The rating is an estimate made by the AI, not a verified score.
• Remembers. Peek at the same page again and the saved summary appears at once, as long as the page has not changed.
• Works on pages that need JavaScript and on PDFs.
• Your format. One plain-language prompt controls length, bullets or prose, language and tone.

HOW TO USE IT
1. Paste your Claude (Anthropic) or OpenAI API key in the settings. One key is all it needs.
2. On any page, hold X and click a link. Or right-click a link and choose "Peek at this link".
3. Read the summary, ask a question, press Esc to close.
You can change the X key to any letter or digit in the settings.

YOU BRING YOUR OWN KEY
LinkPeek has no server, no account and no subscription. It talks directly to the AI provider whose key you enter, and that provider bills you for what you use. A typical summary costs between a fraction of a cent and a few cents, depending on the model you choose.

PRIVACY
• Your API key is stored on your device only and is sent only to the provider it belongs to.
• The text of a page is sent to your AI provider only when you peek at it. Nothing is sent anywhere else. There is no analytics and no tracking.
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
The extension's service worker has no DOM. An offscreen document parses the HTML of the linked page (DOMParser) to extract its readable text. The offscreen document makes no network requests and runs no page scripts.
```

`contextMenus`

```
Adds one item, "Peek at this link", to the context menu of links, as an alternative to the keyboard shortcut.
```

Host permissions (`http://*/*`, `https://*/*`, and the content script on `file:///*`)

```
The user can ask for a summary of any link on any page, so LinkPeek needs to (1) notice the shortcut click on whatever page the user is reading, and (2) fetch the linked page, which can be on any site. Pages are fetched only when the user triggers a peek on a specific link. The extension also calls the API of the AI provider the user configured (api.anthropic.com, api.openai.com, or a base URL the user enters). Local file pages are matched so the shortcut also works on HTML files the user opens from disk; Chrome keeps this off until the user turns on "Allow access to file URLs".
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
https://github.com/galinaalperovich/LinkPeek/blob/main/PRIVACY.md
```

## Distribution tab

- **Payments:** Free of charge.
- **Visibility:** Public.
- **Regions:** All regions.

## Test instructions

The reviewer needs an API key to see a summary. Paste this into the **Test instructions** field, and fill in a key if you are willing to provide one (create a separate key with a low spending limit, and delete it after the review):

```
LinkPeek needs an AI provider API key to produce summaries.

1. After installing, the settings page opens. Paste this test key into the "API key" box: <PASTE A TEST KEY HERE, or write: "Please use any Anthropic or OpenAI API key">
2. Wait for the green "key works" message.
3. Open any article or news page, hold the X key and click a link. A bubble with a summary appears next to the link.
4. Type a question in the box at the bottom of the bubble and press Enter.
5. Hover over the small bar meter in the bubble's header to see the reputation explanation.
6. Press Esc to close the bubble.

Without a key the bubble shows "Add your Claude or OpenAI API key to start peeking" with a button that opens the settings.
```
