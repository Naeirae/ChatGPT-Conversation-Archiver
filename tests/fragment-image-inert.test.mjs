import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
function section(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert.ok(begin !== -1 && finish > begin, 'Missing capture section: ' + start);
  return source.slice(begin, finish);
}

test('marked fragment image placeholders never assign a network-bearing src', () => {
  const clone = section('  function cloneWithImagePlaceholders(', '\n  function cleanClone(');
  assert.match(clone, /placeholder\.setAttribute\('data-archiver-src', src\)/);
  assert.doesNotMatch(clone, /placeholder\.setAttribute\('src', src\)/);
  assert.match(clone, /destination\.appendChild\(placeholder\)/);
});

test('image metadata reads placeholder source without requesting currentSrc', () => {
  const body = section('  function imageSource(', '\n  function imageSize(');
  const fragment = body.slice(body.indexOf('? (img.getAttribute'), body.indexOf(': (img.currentSrc'));
  assert.match(fragment, /getAttribute\('data-archiver-src'\)/);
  assert.doesNotMatch(fragment, /currentSrc/);
});

test('cleaning fragments leaves image clones inert and serialization restores src only as text', () => {
  const clean = section('  function cleanClone(', '\n  function captureTurn(');
  assert.match(clean, /if \(state\.fragmentTextFirst\) img\.setAttribute\('data-archiver-src', src\)/);
  assert.match(clean, /else img\.setAttribute\('src', src\)/);
  const capture = section('  function captureTurn(', '\n  async function blobToDataUrl(');
  assert.match(capture, /clone\.innerHTML\.replace\(/);
  assert.match(capture, /html: extraBefore\.join\(''\) \+ serializedHtml \+ extraAfter\.join\(''\)/);
});

test('marked walks disable inline image binary hydration', () => {
  const begin = source.indexOf('      const walkResult = mode ===');
  const end = source.indexOf('      if (walkResult?.markedEndRebound', begin);
  const call = source.slice(begin, end);
  assert.match(call, /hydrateImages: !queueFragmentResume && mode !== 'fragment'/);
  const deferred = section('      const fragmentImageDeferred =', '\n      if ((mode === \'images\'',);
  assert.match(deferred, /const binaryStats = fragmentImageDeferred/);
});
