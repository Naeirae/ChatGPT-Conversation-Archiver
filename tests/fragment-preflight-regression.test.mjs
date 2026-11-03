import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const captureStart = source.indexOf('async function captureConversation(');
const captureEnd = source.indexOf('// Personal fragment markers', captureStart);
const capture = source.slice(captureStart, captureEnd);

test('fragment start preflight does not clone and collect full DOM before finding mark', () => {
  assert.match(capture, /if \(mode !== 'fragment'\) collect\(map, order, settings, boundary\)/);
  assert.ok(capture.indexOf("if (mode !== 'fragment') collect(") <
    capture.indexOf("} else if (mode === 'fragment') {"));
});

test('marked-start matching compares candidate IDs before costly context capture', () => {
  const begin = capture.indexOf('const strongStart = isStrongMessageId(selectedFragment.start?.id)');
  const end = capture.indexOf('const visibleStart = anchors.find', begin);
  assert.ok(begin > 0 && end > begin);
  const block = capture.slice(begin, end);
  assert.match(block, /mounted\.filter\(/);
  assert.match(block, /turnStableKey\(turn\) === selectedFragment\.start\.id/);
  assert.match(block, /turnTextSignature\(turn\) === selectedFragment\.start\.signature/);
  assert.match(block, /candidates\.map\(turn =>/);
  assert.doesNotMatch(block, /mounted\.map\(turn =>/);
});

test('fragment begin still validates visible identity before saving', () => {
  const begin = capture.indexOf('const visibleStart = anchors.find');
  const end = capture.indexOf('verifiedMarkedStart = true', begin);
  assert.ok(begin > 0 && end > begin);
  const block = capture.slice(begin, end);
  assert.match(block, /turnIntersectsCaptureViewport/); // candidate visibility check
  assert.match(block, /markerIdentityMatches/);
  assert.match(block, /throw new Error/);
});
