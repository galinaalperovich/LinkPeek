// Service workers have no DOM. This hidden extension page does two DOM jobs for
// the service worker:
//   extract  parse fetched HTML into readable text. DOMParser documents are
//            inert: no scripts run, nothing is loaded.
//   icon     decode a site's icon (PNG, ICO, SVG…) into plain pixels, which
//            the bubble can paint on any page whatever its security policy.

const ICON_SIZE = 64;

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function rasterizeIcon(base64, mime) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    // An image loaded this way cannot run scripts or load anything else. The
    // load event is used on purpose: image.decode() never settles in a
    // document that is not being rendered, which this one never is.
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('not an image'));
      image.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const width = image.naturalWidth || ICON_SIZE;
    const height = image.naturalHeight || ICON_SIZE;
    const scale = Math.min(ICON_SIZE / width, ICON_SIZE / height);
    ctx.drawImage(image, (ICON_SIZE - width * scale) / 2, (ICON_SIZE - height * scale) / 2, width * scale, height * scale);
    const { data } = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 16) visible++;
    if (visible < 40) throw new Error('blank icon');
    return { size: ICON_SIZE, rgba: toBase64(data) };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return undefined;
  if (sender.id !== chrome.runtime.id || sender.tab) return undefined; // service worker only

  if (message.type === 'extract') {
    try {
      const doc = new DOMParser().parseFromString(String(message.html), 'text/html');
      sendResponse({ ok: true, result: globalThis.LinkPeekExtract.extract(doc, { url: String(message.url || '') }) });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return undefined;
  }

  if (message.type === 'icon') {
    rasterizeIcon(String(message.bytes), String(message.mime)).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true; // answered asynchronously
  }
  return undefined;
});
