import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRejectedCaptureDraft } from '../lib/capture-recovery.mjs';

test('a rejected three-message capture remains a separate visible draft', () => {
  const archive = {
    id: 'archive-three',
    sourceUrl: 'https://chatgpt.com/c/long-chat',
    title: 'Long chat',
    capturedAt: '2026-10-28T00:00:00Z',
    lastCaptureMode: 'fragment',
    manualRangeMarkers: {
      start: { id: 'data-message-id:first' },
      end: { id: 'data-message-id:last' }
    },
    messages: [
      { id: 'first', role: 'user', text: 'one' },
      { id: 'middle', role: 'assistant', text: 'two', images: [{
        src: 'https://example.org/a.png',
        binaryStatus: 'ready',
        dataUrl: 'data:image/png;base64,ZGF0YQ=='
      }] },
      { id: 'last', role: 'user', text: 'three' }
    ]
  };
  const job = {
    captureMode: 'fragment',
    captureBoundary: { kind: 'stable', key: 'data-message-id:last' }
  };
  const saved = buildRejectedCaptureDraft(archive, job, 'unverified physical end');

  assert.equal(saved.id, 'rejected-finalize:archive-three');
  assert.notEqual(saved.id, archive.id);
  assert.equal(saved.complete, false);
  assert.equal(saved.partial, true);
  assert.equal(saved.capturePhase, 'finalizing');
  assert.equal(saved.captureMode, 'fragment');
  assert.deepEqual(saved.captureRange, archive.manualRangeMarkers);
  assert.equal(saved.captureBoundary.key, job.captureBoundary.key);
  assert.equal(saved.chronologicalCount, 3);
  assert.equal(saved.imageBinaryReady, 1);
  assert.equal(saved.messages.length, 3);
  assert.equal(archive.messages.length, 3);
  assert.equal(saved.messages[1].images[0].dataUrl, 'data:image/png;base64,ZGF0YQ==');
});

test('rejected capture draft uses captured boundary when the job did not persist one', () => {
  const saved = buildRejectedCaptureDraft({
    id: 'capture-2',
    captureBoundaryKind: 'stable',
    captureBoundaryKey: 'data-message-id:final',
    messages: [{ id: 'one', text: 'a' }]
  }, {}, 'unknown');
  assert.deepEqual(saved.captureBoundary, {
    kind: 'stable',
    key: 'data-message-id:final',
    role: ''
  });
});

test('the recovery builder rejects missing message bodies rather than producing an empty fake draft', () => {
  assert.throws(() => buildRejectedCaptureDraft({ id: 'bad' }, {}, ''),
    /Captured archive/);
});
