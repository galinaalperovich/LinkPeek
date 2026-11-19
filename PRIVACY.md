# Privacy

LinkPeek has no server, no account, no analytics and no telemetry. It talks to exactly two kinds of hosts: the page you ask it to read, and the AI provider whose key you entered.

## What is stored, and where

| Data | Where | Leaves your device? |
| --- | --- | --- |
| API key, optional API base URL | The extension's own IndexedDB database on this device | Only as the credential on requests to your AI provider |
| Summary format, model choice, shortcut key | `chrome.storage.sync` | Synced by Chrome to your own signed-in browsers, if you use Chrome sync |
| Pages you peek at, summaries, questions | Memory only, while the bubble is open | Sent to your AI provider (see below); never written to disk by LinkPeek |

The API key is deliberately kept out of `chrome.storage`. Scripts that an extension runs inside web pages can read `chrome.storage`; they cannot open the extension's IndexedDB database. The key is used only by the extension's service worker.

## What is sent, and when

Nothing is sent until you trigger a peek (hold the shortcut key and click a link, or use the context menu).

When you do:

1. **The linked page is requested** from its own site, the same way your browser would load it, including your cookies for that site. This is what lets LinkPeek read pages you are signed in to. If the page needs JavaScript, it is opened in a background tab and then closed.
2. **The page's text** (or the PDF), its address, title and the text of the link you clicked are **sent to your AI provider** together with your format prompt, to produce the summary. Follow-up questions send the same page again along with the conversation so far.

Your provider is Anthropic (`api.anthropic.com`) for Claude keys and OpenAI (`api.openai.com`) for OpenAI keys, or the base URL you set under Advanced. What they do with the data is governed by their API terms and your account settings with them.

Be thoughtful about peeking at links to private pages (documents, mail, internal tools): their content goes to your AI provider just like any other page.

The settings page sends your key to the provider's model-list endpoint to check that it works.

## What a web page can and cannot see

- A page cannot read your API key.
- A page cannot read the bubble. It is rendered in a closed shadow root, so the summary of one site is not visible to the scripts of another.
- A page cannot make LinkPeek peek at something: scripted key presses and clicks are ignored.
- A page can tell that *some* element was added to it while the bubble is open.

## Permissions

See the table in the [README](README.md#privacy-and-security).

## Removing your data

Uninstalling the extension deletes everything it stored. To remove only the key, clear the API key field in the settings.
