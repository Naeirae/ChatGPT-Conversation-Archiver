const DB_NAME = 'chatgpt-conversation-archiver';
const DB_VERSION = 1;
const STORE = 'conversations';
const LAST_ARCHIVE_KEY = 'lastArchiveId';
const DOCS_NEW_URL = 'https://docs.new';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putConversation(conversation) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(conversation);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

async function getConversation(id) {
  if (!id) return null;
  const db = await openDb();
  const value = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

function archiveId(conversation) {
  const safeTitle = String(conversation.title || 'chat').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `${Date.now()}-${safeTitle || 'chat'}`;
}

function isChatGptUrl(url = '') {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url);
}

function isGoogleDocUrl(url = '') {
  return /^https:\/\/docs\.google\.com\/document\//i.test(url);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function captureCurrentChat() {
  const tab = await getActiveTab();
  if (!tab?.id || !isChatGptUrl(tab.url)) throw new Error('Откройте нужную переписку ChatGPT в активной вкладке.');
  const result = await chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_CAPTURE_CONVERSATION' });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось собрать переписку.');
  const conversation = { ...result.conversation, id: archiveId(result.conversation) };
  await putConversation(conversation);
  await chrome.storage.local.set({ [LAST_ARCHIVE_KEY]: conversation.id });
  return summarize(conversation);
}

function summarize(conversation) {
  if (!conversation) return null;
  return {
    id: conversation.id,
    title: conversation.title,
    sourceUrl: conversation.sourceUrl,
    capturedAt: conversation.capturedAt,
    messageCount: conversation.messages?.length || 0,
    imageCount: conversation.imageCount || 0
  };
}

async function lastConversation() {
  const data = await chrome.storage.local.get(LAST_ARCHIVE_KEY);
  return getConversation(data[LAST_ARCHIVE_KEY]);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roleTitle(role) {
  return role === 'user' ? 'Пользователь' : 'ChatGPT';
}

function buildRichHtml(conversation) {
  const chunks = [];
  chunks.push(`<h1>${escapeHtml(conversation.title || 'ChatGPT conversation')}</h1>`);
  if (conversation.sourceUrl) chunks.push(`<p><a href="${escapeHtml(conversation.sourceUrl)}">Исходная переписка ChatGPT</a></p>`);
  chunks.push(`<p><em>Сохранено: ${escapeHtml(new Date(conversation.capturedAt || Date.now()).toLocaleString('ru-RU'))}</em></p>`);
  chunks.push('<hr>');
  for (const msg of conversation.messages || []) {
    chunks.push(`<p><strong>${roleTitle(msg.role)}</strong></p>`);
    chunks.push(`<div>${msg.html || `<p>${escapeHtml(msg.text || '')}</p>`}</div>`);
    chunks.push('<p><br></p>');
  }
  return chunks.join('\n');
}

function buildPlainText(conversation) {
  const lines = [conversation.title || 'ChatGPT conversation'];
  if (conversation.sourceUrl) lines.push(conversation.sourceUrl);
  lines.push('');
  for (const msg of conversation.messages || []) {
    lines.push(`${roleTitle(msg.role)}:`);
    lines.push(msg.text || '');
    lines.push('');
  }
  return lines.join('\n');
}

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('Offscreen API недоступен в этой версии Chrome.');
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] }) : [];
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Write rich ChatGPT conversation HTML to the clipboard before pasting into Google Docs.'
    });
  } catch (error) {
    if (!/single offscreen/i.test(String(error))) throw error;
  }
}

async function writeClipboard(html, text) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_OFFSCREEN_WRITE', target: 'offscreen', html, text });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось записать переписку в буфер обмена.');
}

async function waitForTabComplete(tabId, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && isGoogleDocUrl(tab.url)) return tab;
    await sleep(300);
  }
  throw new Error('Google Docs не загрузился за 30 секунд.');
}

async function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function dispatchKey(tabId, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}

async function editorPoint(tabId) {
  try {
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const selectors = ['.kix-appview-editor', '.kix-page', '[role="textbox"]'];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 100 && r.height > 100) return {x:r.left + Math.min(r.width * 0.5, 500), y:r.top + Math.min(Math.max(140, r.height * 0.2), 350)};
        }
        return {x:Math.max(320, innerWidth * 0.5), y:Math.max(220, Math.min(420, innerHeight * 0.35))};
      })()`,
      returnByValue: true
    });
    return result?.result?.value || { x: 500, y: 300 };
  } catch (_) {
    return { x: 500, y: 300 };
  }
}

async function pasteIntoGoogleDoc(tabId) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(700);
    const point = await editorPoint(tabId);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(450);
    await dispatchKey(tabId, 'v', 'KeyV', 86, 2);
    await sleep(2500);
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  return chrome.tabs.get(tabId);
}

async function exportConversation({ activeDoc = false } = {}) {
  const conversation = await lastConversation();
  if (!conversation) throw new Error('Сначала соберите переписку.');
  await writeClipboard(buildRichHtml(conversation), buildPlainText(conversation));

  let tab;
  if (activeDoc) {
    tab = await getActiveTab();
    if (!tab?.id || !isGoogleDocUrl(tab.url)) throw new Error('Откройте нужный Google Doc в активной вкладке.');
  } else {
    tab = await chrome.tabs.create({ url: DOCS_NEW_URL, active: true });
    await waitForTabComplete(tab.id);
    await sleep(2500);
  }
  const finalTab = await pasteIntoGoogleDoc(tab.id);
  return { docUrl: finalTab.url, archive: summarize(conversation) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return;
  (async () => {
    switch (message?.type) {
      case 'ARCHIVER_CAPTURE_CURRENT':
        return { ok: true, archive: await captureCurrentChat() };
      case 'ARCHIVER_GET_LAST':
        return { ok: true, archive: summarize(await lastConversation()) };
      case 'ARCHIVER_EXPORT_NEW_DOC':
        return { ok: true, ...(await exportConversation({ activeDoc: false })) };
      case 'ARCHIVER_EXPORT_ACTIVE_DOC':
        return { ok: true, ...(await exportConversation({ activeDoc: true })) };
      case 'ARCHIVER_CAPTURE_PROGRESS':
        return { ok: true };
      default:
        return null;
    }
  })().then(result => sendResponse(result)).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
