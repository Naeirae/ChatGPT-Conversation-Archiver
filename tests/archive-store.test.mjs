import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArchiveStore,
  STORAGE_KEYS,
  summarizeArchive
} from '../lib/archive-store.mjs';

function fakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, data[key]]));
      }
      return structuredClone(data);
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(key) {
      delete data[key];
    },
    snapshot() {
      return structuredClone(data);
    }
  };
}

test('summarizeArchive exposes stable UI metadata only', () => {
  const summary = summarizeArchive({
    id: 'a1',
    title: 'Chat',
    sourceUrl: 'https://chatgpt.com/c/abc',
    capturedAt: '2026-10-01T00:00:00Z',
    messages: [{ id: 'm1' }, { id: 'm2' }],
    imageCount: 3,
    imageBinaryReady: 2,
    imageBinaryFailed: 1,
    reasoningMessageCount: 1,
    reasoningBlockCount: 2,
    lastCaptureMode: 'continue',
    lastCaptureAddedCount: 1
  });

  assert.equal(summary.messageCount, 2);
  assert.equal(summary.lastMessageId, 'm2');
  assert.equal(summary.imageBinaryReady, 2);
  assert.equal(summary.reasoningMessageCount, 1);
  assert.equal(summary.reasoningBlockCount, 2);
  assert.equal(summary.partial, false);
  assert.equal(summary.complete, true);
  assert.equal('messages' in summary, false);
});

test('archive index resolves the canonical archive for a conversation URL', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage);
  const archive = {
    id: 'archive-1',
    sourceUrl: 'https://chatgpt.com/g/tool/c/conv-1',
    messages: []
  };

  await store.putArchive(archive);
  await store.indexArchive(archive);

  assert.deepEqual(
    await store.getArchiveForUrl('https://chatgpt.com/c/conv-1'),
    archive
  );
});

test('legacy doc export mapping is recovered into linked-doc state', async () => {
  const storage = fakeStorage({
    [STORAGE_KEYS.docExports]: {
      'doc-1': {
        conversationKey: 'chatgpt.com:conv-1',
        lastMessageId: 'm9'
      }
    }
  });
  const store = createArchiveStore(storage, { now: () => 123 });

  const linked = await store.getLinkedDoc('https://chatgpt.com/c/conv-1');

  assert.equal(linked.docId, 'doc-1');
  assert.equal(linked.lastMessageId, 'm9');
  assert.equal(linked.recoveredFromLegacyExport, true);
  assert.equal(linked.updatedAt, 123);

  const snapshot = storage.snapshot();
  assert.equal(
    snapshot[STORAGE_KEYS.docLinks]['chatgpt.com:conv-1'].docId,
    'doc-1'
  );
});

test('recordDocExport stores a multi-message tail for duplicate-safe continuation', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage, { now: () => 456 });
  const conversation = {
    id: 'archive-2',
    sourceUrl: 'https://chatgpt.com/c/conv-2',
    messages: [
      { id: 'm1', role: 'user', text: 'Один' },
      { id: 'm2', role: 'assistant', text: 'Два' },
      { id: 'm3', role: 'user', text: 'Три' }
    ]
  };

  const linked = await store.recordDocExport(
    conversation,
    'https://docs.google.com/document/d/doc-2/edit?tab=t.abc'
  );

  assert.equal(linked.docId, 'doc-2');
  assert.equal(linked.lastMessageId, 'm3');
  assert.equal(linked.tailSignatures.length, 3);

  const saved = await store.getDocExport('doc-2');
  assert.equal(saved.archiveId, 'archive-2');
  assert.equal(saved.updatedAt, 456);
  assert.equal(saved.tailSignatures.length, 3);
});

test('Google Doc export with images is not marked complete without image verification', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage, { now: () => 500 });
  const conversation = {
    id: 'archive-images-unverified',
    sourceUrl: 'https://chatgpt.com/c/conv-images-unverified',
    imageCount: 2,
    messages: [
      { id: 'm1', role: 'user', text: 'Сообщение с картинками' }
    ]
  };

  const linked = await store.recordDocExport(
    conversation,
    'https://docs.google.com/document/d/doc-images-unverified/edit'
  );

  assert.equal(linked.imageComplete, false);
  assert.equal((await store.getDocExport('doc-images-unverified')).imageComplete, false);
  assert.equal(
    storage.snapshot()[STORAGE_KEYS.archiveDestinations]?.[conversation.id],
    undefined
  );
});

test('verified Google Doc images mark the archive destination complete', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage, { now: () => 501 });
  const conversation = {
    id: 'archive-images-verified',
    sourceUrl: 'https://chatgpt.com/c/conv-images-verified',
    imageCount: 2,
    messages: [
      { id: 'm1', role: 'user', text: 'Сообщение с картинками' }
    ]
  };

  const linked = await store.recordDocExport(
    conversation,
    'https://docs.google.com/document/d/doc-images-verified/edit',
    {
      imageVerificationAvailable: true,
      imageExpectedCount: 2,
      imageVerifiedCount: 2,
      documentImageCount: 2,
      imageComplete: true
    }
  );

  assert.equal(linked.imageComplete, true);
  const saved = await store.getDocExport('doc-images-verified');
  assert.equal(saved.imageComplete, true);
  assert.equal(saved.documentImageCount, 2);
  assert.equal(
    storage.snapshot()[STORAGE_KEYS.archiveDestinations][conversation.id].kind,
    'google-doc'
  );
});

test('no-op relink preserves prior verified image completeness for unchanged archive', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage, { now: () => 502 });
  const conversation = {
    id: 'archive-images-preserve',
    sourceUrl: 'https://chatgpt.com/c/conv-images-preserve',
    imageCount: 1,
    messages: [
      { id: 'm1', role: 'assistant', text: 'Ответ с картинкой' }
    ]
  };

  const url = 'https://docs.google.com/document/d/doc-images-preserve/edit';
  await store.recordDocExport(conversation, url, {
    imageVerificationAvailable: true,
    imageExpectedCount: 1,
    imageVerifiedCount: 1,
    documentImageCount: 1,
    imageComplete: true
  });
  await store.recordDocExport(conversation, url);

  const saved = await store.getDocExport('doc-images-preserve');
  assert.equal(saved.imageComplete, true);
  assert.equal(saved.documentImageCount, 1);
});

test('one-off doc export records target without replacing canonical link', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage, { now: () => 789 });
  const conversation = {
    id: 'archive-3',
    sourceUrl: 'https://chatgpt.com/c/conv-3',
    messages: [
      { id: 'm1', role: 'user', text: 'Один' },
      { id: 'm2', role: 'assistant', text: 'Два' }
    ]
  };

  await store.recordDocExport(
    conversation,
    'https://docs.google.com/document/d/doc-primary/edit'
  );

  const oneOff = await store.recordDocExport(
    conversation,
    'https://docs.google.com/document/d/doc-other/edit',
    { link: false }
  );

  assert.equal(oneOff.docId, 'doc-other');
  assert.equal(oneOff.linked, false);
  assert.equal((await store.getDocExport('doc-other')).linkEligible, false);

  const linked = await store.getLinkedDoc(conversation.sourceUrl);
  assert.equal(linked.docId, 'doc-primary');
});

test('clearLinkedDoc removes the canonical link and prevents legacy export resurrection', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage, { now: () => 999 });
  const conversation = {
    id: 'archive-clear',
    sourceUrl: 'https://chatgpt.com/c/conv-clear',
    messages: [{ id: 'm1', role: 'user', text: 'Один' }]
  };

  await store.recordDocExport(
    conversation,
    'https://docs.google.com/document/d/doc-clear/edit'
  );

  const cleared = await store.clearLinkedDoc(
    conversation.sourceUrl,
    'https://docs.google.com/document/d/doc-clear/edit'
  );

  assert.equal(cleared.cleared, true);
  assert.equal(await store.getLinkedDoc(conversation.sourceUrl), null);
  assert.equal((await store.getDocExport('doc-clear')).linkEligible, false);
  assert.equal((await store.getDocExport('doc-clear')).unlinkedAt, 999);
});

test('one-off doc export never becomes the recovered canonical link', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage);
  const conversation = {
    id: 'archive-4',
    sourceUrl: 'https://chatgpt.com/c/conv-4',
    messages: [{ id: 'm1', role: 'user', text: 'Один' }]
  };

  await store.recordDocExport(
    conversation,
    'https://docs.google.com/document/d/doc-once/edit',
    { link: false }
  );

  assert.equal(await store.getLinkedDoc(conversation.sourceUrl), null);
  assert.equal((await store.getDocExport('doc-once')).linkEligible, false);
});

test('registerArchive exposes only completed local archives in the saved library', async () => {
  const storage = fakeStorage();
  const store = createArchiveStore(storage);

  await store.registerArchive({
    id: 'saved-1',
    title: 'Готовый чат',
    sourceUrl: 'https://chatgpt.com/c/conv-saved',
    capturedAt: '2026-10-16T18:00:00Z',
    complete: true,
    partial: false,
    messages: [{ id: 'm1' }]
  });
  await store.registerArchive({
    id: 'partial-1',
    title: 'Незавершённый чат',
    sourceUrl: 'https://chatgpt.com/c/conv-partial',
    capturedAt: '2026-10-16T18:05:00Z',
    complete: false,
    partial: true,
    messages: [{ id: 'm1' }]
  });

  const library = storage.snapshot()[STORAGE_KEYS.archiveLibrary];
  assert.equal(library['saved-1'].title, 'Готовый чат');
  assert.equal(library['saved-1'].sourceUrl, 'https://chatgpt.com/c/conv-saved');
  assert.equal(library['partial-1'], undefined);
});

test('temporary archives can be removed without touching other state', async () => {
  const storage = fakeStorage({
    [STORAGE_KEYS.archivePrefix + 'temp']: { id: 'temp' },
    [STORAGE_KEYS.archivePrefix + 'good']: { id: 'good' }
  });
  const store = createArchiveStore(storage);

  await store.removeArchive('temp');

  assert.equal(await store.getArchive('temp'), null);
  assert.equal((await store.getArchive('good')).id, 'good');
});


test('deleteArchive clears canonical index and last pointer without touching linked-doc state', async () => {
  const storage = fakeStorage({
    [STORAGE_KEYS.lastArchiveId]: 'bad',
    [STORAGE_KEYS.archiveIndex]: {
      'chatgpt.com:conv-bad': 'bad',
      'chatgpt.com:conv-good': 'good'
    },
    [STORAGE_KEYS.archiveLibrary]: {
      bad: { title: 'Bad' },
      good: { title: 'Good' }
    },
    [STORAGE_KEYS.archivePrefix + 'bad']: {
      id: 'bad',
      sourceUrl: 'https://chatgpt.com/c/conv-bad'
    },
    [STORAGE_KEYS.archivePrefix + 'good']: {
      id: 'good',
      sourceUrl: 'https://chatgpt.com/c/conv-good'
    },
    [STORAGE_KEYS.docLinks]: {
      'chatgpt.com:conv-bad': {
        url: 'https://docs.google.com/document/d/doc/edit'
      }
    }
  });
  const store = createArchiveStore(storage);

  await store.deleteArchive('bad');

  const snapshot = storage.snapshot();
  assert.equal(snapshot[STORAGE_KEYS.archivePrefix + 'bad'], undefined);
  assert.equal(snapshot[STORAGE_KEYS.lastArchiveId], undefined);
  assert.equal(snapshot[STORAGE_KEYS.archiveIndex]['chatgpt.com:conv-bad'], undefined);
  assert.equal(snapshot[STORAGE_KEYS.archiveIndex]['chatgpt.com:conv-good'], 'good');
  assert.equal(snapshot[STORAGE_KEYS.archiveLibrary].bad, undefined);
  assert.equal(snapshot[STORAGE_KEYS.archiveLibrary].good.title, 'Good');
  assert.equal(snapshot[STORAGE_KEYS.docLinks]['chatgpt.com:conv-bad'].url, 'https://docs.google.com/document/d/doc/edit');
});

test('removeDraft deletes only the selected draft', async () => {
  const storage = fakeStorage({
    [STORAGE_KEYS.draftPrefix + 'd1']: { id: 'd1' },
    [STORAGE_KEYS.draftPrefix + 'd2']: { id: 'd2' }
  });
  const store = createArchiveStore(storage);

  await store.removeDraft('d1');

  assert.equal(await store.getDraft('d1'), null);
  assert.equal((await store.getDraft('d2')).id, 'd2');
});


test('listDrafts returns saved unfinished-pass payloads newest first', async () => {
  const storage = fakeStorage({
    [STORAGE_KEYS.draftPrefix + 'old']: {
      id: 'old',
      capturedAt: '2026-10-01T10:00:00Z',
      messages: [{ id: 'm1' }]
    },
    [STORAGE_KEYS.draftPrefix + 'new']: {
      id: 'new',
      capturedAt: '2026-10-02T10:00:00Z',
      messages: [{ id: 'm1' }, { id: 'm2' }]
    },
    unrelated: { id: 'ignore' }
  });
  const store = createArchiveStore(storage);

  const passes = await store.listDrafts();

  assert.deepEqual(passes.map(item => item.id), ['new', 'old']);
  assert.equal(passes[0].messages.length, 2);
});


test('summarizeArchive preserves resumable partial state', () => {
  const summary = summarizeArchive({
    id: 'partial-1',
    title: 'Partial',
    sourceUrl: 'https://chatgpt.com/c/partial-1',
    messages: [{ id: 'm1' }],
    partial: true,
    complete: false,
    partialSaveEnabled: true,
    partialArchiveId: 'partial-1',
    partialSourceDraftId: 'draft-1',
    capturePhase: 'walk'
  });

  assert.equal(summary.partial, true);
  assert.equal(summary.complete, false);
  assert.equal(summary.partialSaveEnabled, true);
  assert.equal(summary.partialArchiveId, 'partial-1');
  assert.equal(summary.partialSourceDraftId, 'draft-1');
  assert.equal(summary.capturePhase, 'walk');
});
