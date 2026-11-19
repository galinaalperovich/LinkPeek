// LinkPeek's promise to be light: zero dependencies, no remote code, small.
// These tests keep that promise from eroding quietly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const walk = (dir) =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('manifest.json'));
const sources = walk('src');

test('the extension has zero dependencies', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
    assert.equal(pkg[field], undefined, `package.json must not have "${field}"`);
  }
  // The one dev tool drives the browser tests. It is never part of the extension.
  assert.deepEqual(Object.keys(pkg.devDependencies), ['playwright']);
});

test('every import stays inside the extension', () => {
  for (const file of sources.filter((name) => name.endsWith('.js'))) {
    const specifiers = [...read(file).matchAll(/\bimport\b[^'"`;]*?['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.match(specifier, /^\.{1,2}\//, `${file} imports "${specifier}"`);
    }
  }
});

test('no code or styles are loaded from the network', () => {
  for (const file of sources.filter((name) => name.endsWith('.html'))) {
    assert.doesNotMatch(read(file), /<(script|link|iframe)[^>]+(src|href)=["']https?:/i, file);
  }
  for (const file of sources.filter((name) => name.endsWith('.js'))) {
    assert.doesNotMatch(read(file), /\beval\s*\(|new Function\s*\(|importScripts\s*\(/, file);
  }
  assert.equal(manifest.content_security_policy, undefined, 'the default (strict) policy is kept');
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing is exposed to web pages');
});

test('there is no build step: the manifest points at files that exist as they are', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.options_ui.page,
    manifest.action.default_popup.split('?')[0],
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...Object.values(manifest.icons),
  ];
  for (const file of referenced) assert.ok(existsSync(path.join(ROOT, file)), `${file} is missing`);
});

test('it stays small: under 250 KB unpacked', () => {
  const shipped = [...sources, 'manifest.json', ...Object.values(manifest.icons)];
  const bytes = shipped.reduce((sum, file) => sum + statSync(path.join(ROOT, file)).size, 0);
  assert.ok(bytes < 250 * 1024, `${Math.round(bytes / 1024)} KB`);
});
