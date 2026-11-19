// A small, safe Markdown renderer for model output.
//
// It builds DOM nodes directly and never touches innerHTML, so nothing a page
// or a model writes can turn into markup or script. It covers what a summary
// uses: headings, paragraphs, nested lists, bold, italic, strikethrough, code,
// quotes, rules and links.
//
// A classic script (not a module) so it can run as a content script.
(() => {
  'use strict';

  const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
  const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const LINK = /^\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/;
  const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~>|]/;
  const WORD = /[\p{L}\p{N}]/u;
  const INLINE_TYPE = { '*': 'em', _: 'em', '**': 'strong', __: 'strong', '~~': 'del' };

  // While a reply is still streaming, an opening ** whose closing half has not
  // arrived yet is rendered as bold instead of flashing literal asterisks.
  let lenient = false;

  const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, '    ').length;
  const isOrdered = (marker) => /\d/.test(marker);

  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
  }

  // ── Inline ─────────────────────────────────────────────────────────────

  function findClose(text, from, marker) {
    const ch = marker[0];
    let i = from;
    while (i < text.length) {
      const at = text.indexOf(ch, i);
      if (at === -1) return -1;
      let run = 1;
      while (text[at + run] === ch) run++;
      const before = text[at - 1] || '';
      const closes = at > from && !/\s/.test(before) && before !== '\\';
      if (closes) {
        if (marker.length === 2) {
          if (run >= 2) return at + run - 2; // "***" closes the inner mark first
        } else if (run % 2 === 1) {
          const after = text[at + run] || '';
          if (!(ch === '_' && WORD.test(after))) return at + run - 1;
        }
      }
      i = at + run;
    }
    return -1;
  }

  function trimUrl(url) {
    let end = url.length;
    while (end > 0) {
      const last = url[end - 1];
      if (/[.,;:!?'"*_]/.test(last)) end--;
      else if (last === ')' && (url.slice(0, end).match(/\(/g) || []).length < (url.slice(0, end).match(/\)/g) || []).length) end--;
      else break;
    }
    return url.slice(0, end);
  }

  function parseInline(text) {
    const nodes = [];
    let buffer = '';
    const flush = () => {
      if (buffer) nodes.push({ type: 'text', text: buffer });
      buffer = '';
    };

    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
        buffer += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '\n') {
        flush();
        nodes.push({ type: 'break' });
        i++;
        continue;
      }
      if (ch === '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) {
          flush();
          nodes.push({ type: 'code', text: text.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
      if (ch === '[') {
        const match = LINK.exec(text.slice(i));
        if (match) {
          flush();
          nodes.push({ type: 'link', href: match[2], children: parseInline(match[1]) });
          i += match[0].length;
          continue;
        }
      }
      if (ch === '<') {
        const match = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(i));
        if (match) {
          flush();
          nodes.push({ type: 'link', href: match[1], children: [{ type: 'text', text: match[1] }] });
          i += match[0].length;
          continue;
        }
      }
      if (ch === 'h' && !/[\w/]/.test(text[i - 1] || '')) {
        const match = /^https?:\/\/[^\s<>"`]+/.exec(text.slice(i));
        const url = match ? trimUrl(match[0]) : '';
        if (url.length > 10) {
          flush();
          nodes.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
      if (ch === '*' || ch === '_' || ch === '~') {
        const double = text[i + 1] === ch;
        if (ch === '~' && !double) {
          buffer += ch;
          i++;
          continue;
        }
        const marker = double ? ch + ch : ch;
        const after = text[i + marker.length] || '';
        const intraword = ch === '_' && WORD.test(text[i - 1] || '');
        if (after && !/\s/.test(after) && !intraword) {
          const start = i + marker.length;
          const close = findClose(text, start, marker);
          if (close !== -1) {
            flush();
            nodes.push({ type: INLINE_TYPE[marker], children: parseInline(text.slice(start, close)) });
            i = close + marker.length;
            continue;
          }
          if (lenient && marker === '**' && !text.includes('\n', start)) {
            flush();
            nodes.push({ type: 'strong', children: parseInline(text.slice(start)) });
            i = text.length;
            continue;
          }
        }
        if (lenient && !after && ch !== '~') {
          i += marker.length; // a marker at the very end is half of a pair still on its way
          continue;
        }
        buffer += marker;
        i += marker.length;
        continue;
      }
      buffer += ch;
      i++;
    }
    flush();
    return nodes;
  }

  // ── Blocks ─────────────────────────────────────────────────────────────

  function parseList(lines, start) {
    const first = LIST_ITEM.exec(lines[start]);
    const base = indentOf(lines[start]);
    const ordered = isOrdered(first[2]);
    const list = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : null, items: [] };
    const raw = []; // { text, children } before inline parsing
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      const match = LIST_ITEM.exec(line);
      if (match) {
        const indent = indentOf(line);
        if (indent < base) break;
        if (indent > base + 1 && raw.length) {
          const [nested, next] = parseList(lines, i);
          raw[raw.length - 1].children.push(nested);
          i = next;
          continue;
        }
        if (isOrdered(match[2]) !== ordered) break; // a different kind of list starts here
        raw.push({ text: match[3], children: [] });
        i++;
        continue;
      }
      if (!line.trim()) {
        // A blank line only continues the list if another item follows it.
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next < lines.length && LIST_ITEM.test(lines[next]) && indentOf(lines[next]) >= base) {
          i = next;
          continue;
        }
        break;
      }
      if (indentOf(line) > base && raw.length && !startsBlock(line)) {
        raw[raw.length - 1].text += '\n' + line.trim(); // wrapped item text
        i++;
        continue;
      }
      break;
    }

    list.items = raw.map((item) => ({ inline: parseInline(item.text), children: item.children }));
    return [list, i];
  }

  function parseLines(lines) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      let match;
      if ((match = FENCE.exec(line))) {
        const fence = match[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++; // the closing fence (or the end of a reply still being streamed)
        blocks.push({ type: 'code', lang: match[2] || '', text: body.join('\n') });
      } else if ((match = HEADING.exec(line))) {
        blocks.push({ type: 'heading', level: match[1].length, inline: parseInline(match[2]) });
        i++;
      } else if (RULE.test(line)) {
        blocks.push({ type: 'rule' });
        i++;
      } else if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && (match = QUOTE.exec(lines[i]))) {
          inner.push(match[1]);
          i++;
        }
        blocks.push({ type: 'quote', blocks: parseLines(inner) });
      } else if (LIST_ITEM.test(line)) {
        const [list, next] = parseList(lines, i);
        blocks.push(list);
        i = next;
      } else {
        const para = [lines[i++].trim()];
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
        blocks.push({ type: 'para', inline: parseInline(para.join('\n')) });
      }
    }
    return blocks;
  }

  /** Markdown text → a plain tree of blocks (no DOM involved). */
  function parse(source, { streaming = false } = {}) {
    lenient = streaming;
    try {
      return parseLines(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'));
    } finally {
      lenient = false;
    }
  }

  // ── DOM ────────────────────────────────────────────────────────────────

  function safeHref(href, baseUrl) {
    try {
      const url = new URL(href, baseUrl || undefined);
      return /^(https?|mailto):$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function appendInline(parent, nodes, doc, baseUrl) {
    for (const node of nodes) {
      if (node.type === 'text') {
        parent.append(doc.createTextNode(node.text));
      } else if (node.type === 'break') {
        parent.append(doc.createElement('br'));
      } else if (node.type === 'code') {
        const code = doc.createElement('code');
        code.textContent = node.text;
        parent.append(code);
      } else if (node.type === 'link') {
        const href = safeHref(node.href, baseUrl);
        if (!href) {
          appendInline(parent, node.children, doc, baseUrl); // unsafe target: keep the words only
          continue;
        }
        const link = doc.createElement('a');
        link.setAttribute('href', href);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        appendInline(link, node.children, doc, baseUrl);
        parent.append(link);
      } else {
        const el = doc.createElement(node.type); // em | strong | del
        appendInline(el, node.children, doc, baseUrl);
        parent.append(el);
      }
    }
  }

  const HEADING_TAGS = ['h3', 'h3', 'h4', 'h5', 'h5', 'h5']; // the bubble is small: no page-sized headings

  function appendBlocks(parent, blocks, doc, baseUrl) {
    for (const block of blocks) {
      let el;
      if (block.type === 'heading') {
        el = doc.createElement(HEADING_TAGS[block.level - 1]);
        appendInline(el, block.inline, doc, baseUrl);
      } else if (block.type === 'para') {
        el = doc.createElement('p');
        appendInline(el, block.inline, doc, baseUrl);
      } else if (block.type === 'code') {
        el = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = block.text;
        el.append(code);
      } else if (block.type === 'rule') {
        el = doc.createElement('hr');
      } else if (block.type === 'quote') {
        el = doc.createElement('blockquote');
        appendBlocks(el, block.blocks, doc, baseUrl);
      } else if (block.type === 'list') {
        el = doc.createElement(block.ordered ? 'ol' : 'ul');
        if (block.ordered && block.start > 1) el.setAttribute('start', String(block.start));
        for (const item of block.items) {
          const li = doc.createElement('li');
          appendInline(li, item.inline, doc, baseUrl);
          appendBlocks(li, item.children, doc, baseUrl);
          el.append(li);
        }
      } else {
        continue;
      }
      parent.append(el);
    }
  }

  /**
   * Markdown text → DocumentFragment.
   * @param {string} source
   * @param {Document} doc
   * @param {{ streaming?: boolean, baseUrl?: string }} [options]
   */
  function render(source, doc, { streaming = false, baseUrl = '' } = {}) {
    const fragment = doc.createDocumentFragment();
    appendBlocks(fragment, parse(source, { streaming }), doc, baseUrl);
    return fragment;
  }

  globalThis.LinkPeekMarkdown = { parse, render };
})();
