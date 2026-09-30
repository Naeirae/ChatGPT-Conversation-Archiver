const $ = id => document.getElementById(id);
let lastArchive = null;

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function renderArchive(archive) {
  lastArchive = archive || null;
  const has = Boolean(archive?.id);
  $('archive').classList.toggle('hidden', !has);
  $('newDoc').disabled = !has;
  $('activeDoc').disabled = !has;
  if (!has) return;
  $('archiveTitle').textContent = archive.title || 'ChatGPT conversation';
  $('archiveMeta').textContent = `${archive.messageCount || 0} сообщений · ${archive.imageCount || 0} изображений`;
}

async function ask(type) {
  const result = await chrome.runtime.sendMessage({ type });
  if (!result?.ok) throw new Error(result?.error || 'Операция не выполнена.');
  return result;
}

$('capture').onclick = async () => {
  $('capture').disabled = true;
  setStatus('Собираю переписку…');
  try {
    const result = await ask('ARCHIVER_CAPTURE_CURRENT');
    renderArchive(result.archive);
    setStatus(`Собрано: ${result.archive.messageCount} сообщений, ${result.archive.imageCount} изображений.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('capture').disabled = false;
  }
};

$('newDoc').onclick = async () => {
  $('newDoc').disabled = true;
  setStatus('Открываю Google Docs и вставляю архив…');
  try {
    const result = await ask('ARCHIVER_EXPORT_NEW_DOC');
    setStatus('Готово. Переписка вставлена в новый Google Doc.');
    if (result.archive) renderArchive(result.archive);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('newDoc').disabled = !lastArchive;
  }
};

$('activeDoc').onclick = async () => {
  $('activeDoc').disabled = true;
  setStatus('Вставляю архив в открытый Google Doc…');
  try {
    const result = await ask('ARCHIVER_EXPORT_ACTIVE_DOC');
    setStatus('Готово. Переписка вставлена в открытый Google Doc.');
    if (result.archive) renderArchive(result.archive);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('activeDoc').disabled = !lastArchive;
  }
};

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'ARCHIVER_CAPTURE_PROGRESS') setStatus(message.message || 'Собираю переписку…');
});

(async () => {
  try {
    const result = await ask('ARCHIVER_GET_LAST');
    renderArchive(result.archive);
  } catch (_) {}
})();
