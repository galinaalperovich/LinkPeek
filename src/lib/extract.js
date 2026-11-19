// Turns a document into readable, lightly structured text for the model.
//
// A classic script (not a module) because it runs in three places: the
// offscreen document (HTML fetched in the background), a background tab
// (pages that need JavaScript to render), and the test suite.
(() => {
  'use strict';

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'link', 'meta', 'title', 'base',
    'svg', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'map', 'picture', 'img',
    'nav', 'footer', 'aside', 'dialog', 'menu',
    'button', 'input', 'select', 'textarea', 'datalist', 'option',
  ]);
  const SKIP_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary', 'search',
    'menu', 'menubar', 'toolbar', 'dialog', 'alertdialog', 'tooltip',
  ]);
  const BLOCK_TAGS = new Set([
    'address', 'article', 'blockquote', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'form', 'header', 'hgroup', 'main', 'p', 'section',
    'summary', 'table', 'tbody', 'tfoot', 'thead',
  ]);
  // Small boxes that are never the point of a page. Only applied to elements
  // holding little text, so a page *about* cookies is not thrown away.
  const NOISE = /(^|[\s_-])(cookies?|consent|gdpr|newsletter|subscribe|breadcrumbs?|share|social|advert\w*|sponsor\w*|promo)([\s_-]|$)/i;
  const NOISE_MAX_CHARS = 1200;
  const CJK = /[぀-ヿ㐀-鿿가-힯]/g;

  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  function meta(doc, ...names) {
    for (const name of names) {
      const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`);
      const value = clean(el?.getAttribute('content'));
      if (value) return value;
    }
    return '';
  }

  function authorName(author) {
    if (!author) return '';
    if (typeof author === 'string') return clean(author);
    if (Array.isArray(author)) return author.map(authorName).filter(Boolean).join(', ');
    return clean(author.name);
  }

  // Many news sites ship the full article as structured data, including ones
  // whose visible markup is a paywall teaser or an empty JavaScript shell.
  function structuredData(doc) {
    const found = { body: '', headline: '', published: '', author: '', description: '' };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const queue = [data];
      for (let steps = 0; queue.length && steps < 500; steps++) {
        const node = queue.pop();
        if (Array.isArray(node)) {
          queue.push(...node);
          continue;
        }
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
        const type = [].concat(node['@type'] || []).join(' ');
        if (!/Article|Posting|Report|WebPage|Recipe|Product|VideoObject|Review|Event|Book|Dataset/i.test(type)) continue;
        const body = typeof node.articleBody === 'string' ? node.articleBody.trim() : '';
        if (body.length > found.body.length) found.body = body;
        found.headline ||= clean(typeof node.headline === 'string' ? node.headline : node.name);
        found.published ||= clean(node.datePublished || node.uploadDate);
        found.author ||= authorName(node.author);
        found.description ||= clean(typeof node.description === 'string' ? node.description : '');
      }
    }
    return found;
  }

  function isHidden(el, live) {
    if (el.hidden) return true;
    const inline = el.getAttribute('style');
    if (inline && /display\s*:\s*none/i.test(inline)) return true;
    if (live) {
      try {
        return el.ownerDocument.defaultView.getComputedStyle(el).display === 'none';
      } catch {
        return false;
      }
    }
    return false;
  }

  function isNoise(el, rootChars) {
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    const label = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
    if (label.length < 4 || !NOISE.test(label)) return false;
    const chars = el.textContent.length;
    return chars < NOISE_MAX_CHARS && chars < rootChars / 2;
  }

  function shadowRootOf(el, live) {
    if (!live) return null;
    try {
      return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot ?? null;
    } catch {
      return el.shadowRoot ?? null;
    }
  }

  // The element holding most of the page's paragraph text, when one stands out.
  function pickRoot(doc) {
    const body = doc.body || doc.documentElement;
    const paragraphChars = (el) => {
      let total = 0;
      for (const p of el.querySelectorAll('p')) total += p.textContent.length;
      return total;
    };
    const total = paragraphChars(body);
    if (total < 200) return body;
    let best = body;
    let bestChars = Infinity;
    const selectors = [
      '[itemprop="articleBody"]', 'article', 'main', '[role="main"]',
      '#content', '#main-content', '.post-content', '.article-content', '.entry-content',
    ];
    for (const selector of selectors) {
      const matches = doc.querySelectorAll(selector);
      if (matches.length !== 1) continue; // several <article>s means a feed or a thread
      const chars = paragraphChars(matches[0]);
      if (chars >= total * 0.7 && chars < bestChars) {
        best = matches[0];
        bestChars = chars;
      }
    }
    return best;
  }

  function serialize(root, live) {
    const rootChars = root.textContent.length;
    const preBlocks = [];
    let out = '';

    const visit = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const text = child.nodeValue.replace(/\s+/g, ' ');
          // Indentation between list items or table rows is not content.
          if (text !== ' ' || !out.endsWith('\n')) out += text;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.localName;
        if (SKIP_TAGS.has(tag) || isHidden(child, live) || isNoise(child, rootChars)) continue;

        if (tag === 'br') out += '\n';
        else if (tag === 'hr') out += '\n\n';
        else if (tag === 'pre') {
          preBlocks.push(child.textContent.replace(/\s+$/, ''));
          out += `\n\n\u0000${preBlocks.length - 1}\u0000\n\n`;
        } else if (/^h[1-6]$/.test(tag)) {
          out += `\n\n${'#'.repeat(Number(tag[1]))} `;
          visit(child);
          out += '\n\n';
        } else if (tag === 'li') {
          out += '\n- ';
          visit(child);
          out += '\n';
        } else if (tag === 'tr' || tag === 'ul' || tag === 'ol') {
          out += '\n';
          visit(child);
          out += '\n';
        } else if (tag === 'td' || tag === 'th') {
          visit(child);
          out += ' | ';
        } else {
          const block = BLOCK_TAGS.has(tag);
          if (block) out += '\n\n';
          const shadow = shadowRootOf(child, live);
          if (shadow) visit(shadow);
          visit(child);
          if (block) out += '\n\n';
        }
      }
    };

    try {
      visit(root);
    } catch {
      out = root.textContent || ''; // absurdly deep DOM: settle for raw text
    }

    return out
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/^(?:-|#{1,6}|\|)$/gm, '') // markers left behind by empty elements
      .replace(/( \|)+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .replace(/\u0000(\d+)\u0000/g, (_, index) => '```\n' + preBlocks[Number(index)] + '\n```');
  }

  /**
   * @param {Document} doc
   * @param {{ live?: boolean }} [options] live: the document is rendered in a
   *        tab, so computed styles and shadow roots can be consulted.
   */
  function extract(doc, { live = false } = {}) {
    const ld = structuredData(doc);
    const root = pickRoot(doc);
    let text = serialize(root, live);
    if (root !== doc.body && text.length < 200 && doc.body) text = serialize(doc.body, live);
    if (ld.body.length > 600 && ld.body.length > text.length * 1.5) text = ld.body;

    const title =
      meta(doc, 'og:title', 'twitter:title') ||
      clean(doc.title) ||
      ld.headline ||
      clean(doc.querySelector('h1')?.textContent);
    const author = meta(doc, 'author', 'article:author', 'parsely-author');
    const byline =
      (/^https?:/i.test(author) ? '' : author) ||
      ld.author ||
      clean(doc.querySelector('[rel="author"], [itemprop="author"]')?.textContent).slice(0, 120);
    const published =
      meta(doc, 'article:published_time', 'datePublished', 'date', 'parsely-pub-date') ||
      ld.published ||
      clean(root.querySelector?.('time[datetime]')?.getAttribute('datetime'));

    const cjkChars = (text.match(CJK) || []).length;
    const words = (text.replace(CJK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

    return {
      title: title.slice(0, 300),
      siteName: meta(doc, 'og:site_name', 'application-name').slice(0, 120),
      byline,
      published: published.slice(0, 60),
      description: (meta(doc, 'og:description', 'description', 'twitter:description') || ld.description).slice(0, 1000),
      lang: clean(doc.documentElement?.getAttribute('lang')).slice(0, 20),
      text,
      wordCount: words + cjkChars,
      readMinutes: Math.max(1, Math.round(words / 230 + cjkChars / 500)),
    };
  }

  globalThis.LinkPeekExtract = { extract };
})();
