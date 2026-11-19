// Service workers have no DOM. This hidden extension page parses fetched HTML
// for them. DOMParser documents are inert: no scripts run, nothing is loaded.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'extract') return undefined;
  if (sender.id !== chrome.runtime.id || sender.tab) return undefined; // service worker only
  try {
    const doc = new DOMParser().parseFromString(String(message.html), 'text/html');
    sendResponse({ ok: true, result: globalThis.LinkPeekExtract.extract(doc) });
  } catch (err) {
    sendResponse({ ok: false, error: String(err?.message || err) });
  }
  return undefined;
});
