import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/lib/markdown.js';

const { parse, render } = globalThis.LinkPeekMarkdown;

// Just enough DOM to turn render() output back into a string.
const fakeDocument = (() => {
  const node = (tag) => ({
    tag,
    attrs: {},
    children: [],
    append(...items) {
      this.children.push(...items);
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    set textContent(value) {
      this.children = [{ text: String(value) }];
    },
  });
  return {
    createDocumentFragment: () => node(''),
    createElement: (tag) => node(tag),
    createTextNode: (text) => ({ text }),
  };
})();

function html(el) {
  if ('text' in el) return el.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const inner = el.children.map(html).join('');
  if (!el.tag) return inner;
  const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}

const toHtml = (source, options) => html(render(source, fakeDocument, options));

test('a typical summary: bold TL;DR, bullets, closing line', () => {
  const out = toHtml('**TL;DR:** Bread rises.\n\n- First point\n- Second **bold** point\nWorth knowing: it takes a week.');
  assert.equal(
    out,
    '<p><strong>TL;DR:</strong> Bread rises.</p>' +
      '<ul><li>First point</li><li>Second <strong>bold</strong> point</li></ul>' +
      '<p>Worth knowing: it takes a week.</p>',
  );
});

test('headings are scaled down for the bubble', () => {
  assert.equal(toHtml('# Title\n## Section ##\n#### Deep'), '<h3>Title</h3><h3>Section</h3><h5>Deep</h5>');
  assert.equal(toHtml('## Using C#'), '<h3>Using C#</h3>');
});

test('nested and ordered lists', () => {
  const [list] = parse('1. one\n2. two\n   - inner a\n   - inner b\n3. three');
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
  assert.equal(list.items[1].children[0].items.length, 2);
  assert.equal(toHtml('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
});

test('blank lines between items keep one list; wrapped item text is joined', () => {
  const blocks = parse('- one\n\n- two\n  continues here\n\nAfter.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].type, 'para');
});

test('inline marks', () => {
  assert.equal(toHtml('*em* _em_ **strong** __strong__ ~~gone~~ `code`'),
    '<p><em>em</em> <em>em</em> <strong>strong</strong> <strong>strong</strong> <del>gone</del> <code>code</code></p>');
  assert.equal(toHtml('***both***'), '<p><strong><em>both</em></strong></p>');
  assert.equal(toHtml('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
});

test('things that look like marks but are not', () => {
  assert.equal(toHtml('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
  assert.equal(toHtml('a \\*literal\\* star'), '<p>a *literal* star</p>');
  assert.equal(toHtml('~approx~ and **unclosed'), '<p>~approx~ and **unclosed</p>');
});

test('single newlines become line breaks', () => {
  assert.equal(toHtml('line one\nline two'), '<p>line one<br></br>line two</p>');
});

test('links: markdown, angle and bare, with trailing punctuation left out', () => {
  assert.equal(toHtml('[docs](https://example.com/a)'),
    '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a></p>');
  assert.match(toHtml('See https://example.com/page.'), /href="https:\/\/example\.com\/page"[^>]*>https:\/\/example\.com\/page<\/a>\.<\/p>$/);
  assert.match(toHtml('(https://en.wikipedia.org/wiki/Rust_(language))'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Rust_\(language\)"/);
  assert.match(toHtml('<https://example.com>'), /<a href="https:\/\/example\.com\/"/);
});

test('relative links resolve against the page; unsafe links lose their target', () => {
  assert.match(toHtml('[next](/page/2)', { baseUrl: 'https://example.com/blog/post' }), /href="https:\/\/example\.com\/page\/2"/);
  assert.equal(toHtml('[click](javascript:alert(1))'), '<p>click)</p>');
  assert.equal(toHtml('[x](data:text/html,boom)'), '<p>x</p>');
  assert.equal(toHtml('[rel](/no-base)'), '<p>rel</p>');
});

test('markup in the text stays text', () => {
  assert.equal(toHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)></p>');
});

test('code fences, quotes and rules', () => {
  assert.equal(toHtml('```js\nconst a = 1;\n```'), '<pre><code>const a = 1;</code></pre>');
  assert.equal(toHtml('```\nstill streaming'), '<pre><code>still streaming</code></pre>');
  assert.equal(toHtml('> quoted\n> more'), '<blockquote><p>quoted<br></br>more</p></blockquote>');
  assert.equal(toHtml('above\n\n---\n\nbelow'), '<p>above</p><hr></hr><p>below</p>');
});

test('while streaming, a half-open bold renders as bold', () => {
  assert.equal(toHtml('**TL;DR: The', { streaming: true }), '<p><strong>TL;DR: The</strong></p>');
  assert.equal(toHtml('Done. **', { streaming: true }), '<p>Done. </p>');
  assert.equal(toHtml('**TL;DR: The'), '<p>**TL;DR: The</p>');
});
