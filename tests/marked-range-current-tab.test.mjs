import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const popup = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');

test('the primary marked-range button uses the already positioned current tab', () => {
  const start = popup.indexOf("$('captureFragment').onclick = async () => {");
  const end = popup.indexOf("\n};", start);
  assert.ok(start > 0 && end > start);
  const handler = popup.slice(start, end);
  assert.match(handler, /type: 'ARCHIVER_CAPTURE_FRAGMENT'/);
  assert.match(handler, /captureTarget: 'current'/);
  assert.doesNotMatch(handler, /captureTarget: \$\('captureTarget'\)\.value/);
});

test('the worker only asks to seek the marked start in a background copy', () => {
  assert.match(worker, /seekMarkedStart: mode === 'fragment' && captureTarget === 'copy'/);
  const fragment = collector.slice(
    collector.indexOf("} else if (mode === 'fragment') {", collector.indexOf('async function captureConversation(')),
    collector.indexOf("} else if (mode === 'retry-walk')")
  );
  assert.match(fragment, /if \(options\.seekMarkedStart\) \{/);
  assert.match(fragment, /await seekQueueMarkedStart\(selectedFragment\.start\)/);
  assert.match(fragment, /verifiedMarkedStart = true/);
  assert.match(fragment, /phase: 'walk'/);
});

test('the UI states that marked ranges use the source tab, not background preference', () => {
  assert.match(html, /Сбор по отметкам идёт в этой вкладке/);
  assert.match(popup, /сбор по отметкам пойдёт прямо отсюда вниз/);
});
