import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('async function pasteArchiveIntoGoogleDoc(');
const end = source.indexOf('\nfunction normalizeDocSearchText', start);
assert.ok(start >= 0 && end > start);
const exporter = source.slice(start, end);

test('the chronological message stream is pasted once before any image work', () => {
  const textPaste = exporter.indexOf(
    'await pasteChunk(orderedMessages, includeHeader, { stripImages: true })'
  );
  const imagePass = exporter.indexOf('const imageMessages = orderedMessages.filter');
  assert.ok(textPaste >= 0 && imagePass > textPaste);
  assert.equal((exporter.match(/await pasteChunk\(/g) || []).length, 1);
});

test('each image group is positioned by a unique message anchor, not Ctrl+End', () => {
  const imagePass = exporter.indexOf('const imageMessages = orderedMessages.filter');
  const block = exporter.slice(imagePass);
  assert.match(block, /uniqueMessageAnchor\(actualText, message\)/);
  assert.match(block, /locateGoogleDocAnchor\(tabId, anchor\)/);
  assert.doesNotMatch(block, /dispatchKey\(tabId, 'End', 'End'/);
});

test('text insertion is verified before image insertion starts', () => {
  const verify = exporter.indexOf('Google Docs не подтвердил вставку последнего текстового сообщения');
  const images = exporter.indexOf('const imageMessages = orderedMessages.filter');
  assert.ok(verify >= 0 && images > verify);
});

test('images without ready binary data are reported without changing text order', () => {
  const imagePass = exporter.indexOf('const imageMessages = orderedMessages.filter');
  const block = exporter.slice(imagePass);
  assert.match(block, /image\.binaryStatus !== 'ready' \|\| !image\?\.dataUrl/);
  assert.match(block, /Текст сохранён/);
});
