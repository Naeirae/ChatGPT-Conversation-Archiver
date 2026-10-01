import test from 'node:test';
import assert from 'node:assert/strict';

import {
  conversationKey,
  googleDocKey,
  googleDocTabToken,
  isConversationUrl,
  normalizeGoogleDocUrl
} from '../lib/urls.mjs';

test('recognizes regular and project ChatGPT conversation URLs', () => {
  assert.equal(isConversationUrl('https://chatgpt.com/c/abc-123'), true);
  assert.equal(isConversationUrl('https://chatgpt.com/g/gpt-id/project-name/c/abc-123'), true);
  assert.equal(isConversationUrl('https://chatgpt.com/'), false);
});

test('conversation key is stable for the same host and conversation id', () => {
  assert.equal(
    conversationKey('https://chatgpt.com/g/foo/c/abc-123'),
    'chatgpt.com:abc-123'
  );
});

test('accepts legacy conversationId query parameter', () => {
  assert.equal(
    isConversationUrl('https://chat.openai.com/?conversationId=legacy-1'),
    true
  );
  assert.equal(
    conversationKey('https://chat.openai.com/?conversationId=legacy-1'),
    'chat.openai.com:legacy-1'
  );
});

test('extracts Google Doc id and tab token', () => {
  const url = 'https://docs.google.com/document/d/doc-123/edit?tab=t.abc';
  assert.equal(googleDocKey(url), 'doc-123');
  assert.equal(googleDocTabToken(url), 't.abc');
});

test('rejects non-Google document URLs', () => {
  assert.equal(normalizeGoogleDocUrl('https://example.com/document/d/doc-123'), '');
  assert.equal(normalizeGoogleDocUrl('javascript:alert(1)'), '');
});
