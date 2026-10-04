import { exportTailSignatures, messageSignature } from './text.mjs';
import { conversationKey, googleDocKey, normalizeGoogleDocUrl } from './urls.mjs';

export const STORAGE_KEYS = Object.freeze({
  lastArchiveId: 'lastArchiveId',
  archivePrefix: 'archive:',
  draftPrefix: 'draft:',
  archiveIndex: 'archiveIndex',
  docExports: 'docExports',
  docLinks: 'docLinks'
});

export function archiveKey(id) {
  return STORAGE_KEYS.archivePrefix + id;
}

export function summarizeArchive(conversation) {
  if (!conversation) return null;
  return {
    id: conversation.id,
    title: conversation.title,
    sourceUrl: conversation.sourceUrl,
    capturedAt: conversation.capturedAt,
    messageCount: conversation.messages?.length || 0,
    imageCount: conversation.imageCount || 0,
    imageBinaryReady: conversation.imageBinaryReady || 0,
    imageBinaryFailed: conversation.imageBinaryFailed || 0,
    lastImageBinaryReady: conversation.lastImageBinaryReady || 0,
    lastImageBinaryFailed: conversation.lastImageBinaryFailed || 0,
    lastImageRecoveredCount: conversation.lastImageRecoveredCount || 0,
    recoveredImagePendingPatchCount: Array.isArray(conversation.lastRecoveredImageRefs)
      ? conversation.lastRecoveredImageRefs.length
      : 0,
    reasoningMessageCount: conversation.reasoningMessageCount || 0,
    reasoningBlockCount: conversation.reasoningBlockCount || 0,
    lastCaptureAddedCount: conversation.lastCaptureAddedCount || 0,
    lastCaptureMode: conversation.lastCaptureMode || 'full',
    lastMessageId:
      conversation.lastMessageId ||
      conversation.messages?.[conversation.messages.length - 1]?.id ||
      ''
  };
}

export function createArchiveStore(storageArea, { now = () => Date.now() } = {}) {
  if (!storageArea?.get || !storageArea?.set || !storageArea?.remove) {
    throw new TypeError('A storage area with get/set/remove is required.');
  }

  async function getArchive(id) {
    if (!id) return null;
    const key = archiveKey(id);
    const result = await storageArea.get(key);
    return result[key] || null;
  }

  async function putArchive(archive) {
    if (!archive?.id) throw new Error('Archive id is required.');
    await storageArea.set({ [archiveKey(archive.id)]: archive });
    return archive;
  }

  async function removeArchive(id) {
    if (!id) return;
    await storageArea.remove(archiveKey(id));
  }

  async function getDraft(id) {
    if (!id) return null;
    const key = STORAGE_KEYS.draftPrefix + id;
    const result = await storageArea.get(key);
    return result[key] || null;
  }

  async function getLastArchive() {
    const result = await storageArea.get(STORAGE_KEYS.lastArchiveId);
    return getArchive(result[STORAGE_KEYS.lastArchiveId]);
  }

  async function getArchiveForUrl(url = '') {
    const key = conversationKey(url);
    if (!key) return null;
    const result = await storageArea.get(STORAGE_KEYS.archiveIndex);
    const index = result[STORAGE_KEYS.archiveIndex] || {};
    return getArchive(index[key]);
  }

  async function indexArchive(conversation) {
    const key = conversationKey(conversation?.sourceUrl || '');
    if (!key || !conversation?.id) return null;
    const result = await storageArea.get(STORAGE_KEYS.archiveIndex);
    const index = {
      ...(result[STORAGE_KEYS.archiveIndex] || {}),
      [key]: conversation.id
    };
    await storageArea.set({ [STORAGE_KEYS.archiveIndex]: index });
    return conversation.id;
  }

  async function setLinkedDoc(chatUrl = '', docInfo = null) {
    const key = conversationKey(chatUrl);
    if (!key || !docInfo?.url) return null;

    const result = await storageArea.get(STORAGE_KEYS.docLinks);
    const links = { ...(result[STORAGE_KEYS.docLinks] || {}) };
    links[key] = {
      ...docInfo,
      url: normalizeGoogleDocUrl(docInfo.url) || docInfo.url,
      updatedAt: now()
    };
    await storageArea.set({ [STORAGE_KEYS.docLinks]: links });
    return links[key];
  }

  async function getLinkedDoc(chatUrl = '') {
    const key = conversationKey(chatUrl);
    if (!key) return null;

    const result = await storageArea.get([
      STORAGE_KEYS.docLinks,
      STORAGE_KEYS.docExports
    ]);
    const direct = (result[STORAGE_KEYS.docLinks] || {})[key] || null;
    if (direct) return direct;

    const exports = result[STORAGE_KEYS.docExports] || {};
    for (const [docId, entry] of Object.entries(exports)) {
      if (entry?.conversationKey !== key) continue;
      if (entry?.linkEligible === false) continue;

      const recovered = {
        url: entry.docUrl || ('https://docs.google.com/document/d/' + docId + '/edit'),
        docId,
        lastMessageId: entry.lastMessageId || '',
        lastMessageSignature: entry.lastMessageSignature || '',
        tailSignatures: Array.isArray(entry.tailSignatures) ? entry.tailSignatures : [],
        recoveredFromLegacyExport: true
      };
      return setLinkedDoc(chatUrl, recovered);
    }

    return null;
  }

  async function getDocExport(docId) {
    if (!docId) return null;
    const result = await storageArea.get(STORAGE_KEYS.docExports);
    return (result[STORAGE_KEYS.docExports] || {})[docId] || null;
  }

  async function recordDocExport(conversation, docUrl, { link = true } = {}) {
    const docId = googleDocKey(docUrl);
    if (!docId || !conversation) return null;

    const result = await storageArea.get(STORAGE_KEYS.docExports);
    const exports = result[STORAGE_KEYS.docExports] || {};
    const messages = conversation.messages || [];
    const lastMessage = messages[messages.length - 1] || null;
    const lastMessageId = lastMessage?.id || '';
    const lastMessageSignature = lastMessage
      ? messageSignature(lastMessage.role, lastMessage.text)
      : '';
    const tailSignatures = exportTailSignatures(messages);

    exports[docId] = {
      conversationKey: conversationKey(conversation.sourceUrl),
      archiveId: conversation.id,
      lastMessageId,
      lastMessageSignature,
      tailSignatures,
      docUrl,
      linkEligible: link,
      updatedAt: now()
    };
    await storageArea.set({ [STORAGE_KEYS.docExports]: exports });

    if (!link) {
      return {
        url: docUrl,
        docId,
        lastMessageId,
        lastMessageSignature,
        tailSignatures,
        linked: false
      };
    }

    return setLinkedDoc(conversation.sourceUrl, {
      url: docUrl,
      docId,
      lastMessageId,
      lastMessageSignature,
      tailSignatures
    });
  }

  return {
    getArchive,
    putArchive,
    removeArchive,
    getDraft,
    getLastArchive,
    getArchiveForUrl,
    indexArchive,
    getLinkedDoc,
    setLinkedDoc,
    getDocExport,
    recordDocExport
  };
}
