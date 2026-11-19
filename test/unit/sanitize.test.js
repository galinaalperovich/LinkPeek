import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeHandlers } from '../../src/lib/page-loader.js';

test('inline event handlers are renamed inside tags', () => {
  assert.equal(
    neutralizeHandlers('<body onload="init()"><img src="a.png" onerror=\'fallback(this)\' alt="x"><a href="#" onClick=go()>go</a>'),
    '<body data-lp-onload="init()"><img src="a.png" data-lp-onerror=\'fallback(this)\' alt="x"><a href="#" data-lp-onClick=go()>go</a>',
  );
  assert.equal(neutralizeHandlers('<div class="x"onmouseover="a()">t</div>'), '<div class="x"data-lp-onmouseover="a()">t</div>');
});

test('a ">" inside a quoted attribute does not end the tag early', () => {
  assert.equal(
    neutralizeHandlers('<button title="a > b" onclick="if (a > b) run()">ok</button>'),
    '<button title="a > b" data-lp-onclick="if (a > b) run()">ok</button>',
  );
});

test('text between tags is left alone, and so are harmless attributes', () => {
  const html = '<p>Set onclick="run()" on the button, or use online=true.</p><a href="/one" data-on="1" contenteditable>x</a>';
  assert.equal(neutralizeHandlers(html), html);
});

test('nothing that looks like a handler survives in a tag', () => {
  const out = neutralizeHandlers('<svg onload=x()><animate onbegin="y()"/></svg><details open ontoggle="z()">');
  assert.ok(!/[\s"'/]on[a-z]+\s*=/i.test(out), out);
});
