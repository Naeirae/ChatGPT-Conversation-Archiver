const $ = id => document.getElementById(id);
let pollTimer = null;
let state = null;

const DEFAULT_SETTINGS = {
  userName: '',
  assistantName: '',
  palette: 'ocean',
  alignUserRight: true,
  includeReasoning: false
};

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function applyPalette(palette) {
  document.documentElement.dataset.palette = palette || 'ocean';
}

async function loadSettings() {
  const result = await chrome.storage.local.get('archiverSettings');
  return { ...DEFAULT_SETTINGS, ...(result.archiverSettings || {}) };
}

async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ archiverSettings: next });
  applyPalette(next.palette);
  $('settingsSaved').textContent = 'Сохранено';
  clearTimeout(saveSettings.timer);
  saveSettings.timer = setTimeout(() => { $('settingsSaved').textContent = ''; }, 900);
}

function render(data) {
  state = data || {};
  const job = state.job;
  const archive = state.archive;
  const running = job && ['starting', 'running', 'paused'].includes(job.status);
  const done = job?.status === 'done' && archive;

  $('capture').disabled = Boolean(running);
  $('capture').textContent = running ? 'Сбор идет в фоне…' : 'Собрать текущий чат';
  $('cancel').classList.toggle('hidden', !running);

  if (done) {
    $('archive').classList.remove('hidden');
    $('archiveTitle').textContent = archive.title || 'Переписка ChatGPT';
    $('archiveMeta').textContent = `${archive.messageCount || 0} сообщений · ${archive.imageCount || 0} изображений`;
    $('newDoc').disabled = false;
    $('activeDoc').disabled = false;
  } else {
    $('archive').classList.toggle('hidden', !archive);
    $('archiveTitle').textContent = archive?.title || '';
    $('archiveMeta').textContent = archive ? `${archive.messageCount || 0} сообщений · ${archive.imageCount || 0} изображений` : '';
    $('newDoc').disabled = true;
    $('activeDoc').disabled = true;
  }

  if (running) setStatus(job.message || 'Сбор идет в фоне…');
  else if (job?.status === 'error') setStatus(job.message || 'Сбор не выполнен.', true);
  else if (job?.status === 'cancelled') setStatus('Сбор отменен.');
  else if (done) setStatus(`Готово: ${archive.messageCount || 0} сообщений, ${archive.imageCount || 0} изображений.`);
  else setStatus('Готово.');
}

async function getState() {
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_STATE' });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось получить состояние.');
  render(result);
  return result;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => getState().catch(() => {}), 650);
}

async function exportToDoc(type) {
  const result = await chrome.runtime.sendMessage({ type });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить в Google Docs.');
  return result;
}

$('capture').onclick = async () => {
  $('capture').disabled = true;
  setStatus('Запускаю сбор в фоне…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_CAPTURE_CURRENT' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось запустить сбор.');
    render({ job: result.job, archive: state?.archive || null });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('capture').disabled = false;
  }
};

$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'ARCHIVER_CANCEL_CAPTURE', jobId: state?.job?.jobId });
    await getState();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('cancel').disabled = false;
  }
};

$('newDoc').onclick = async () => {
  $('newDoc').disabled = true;
  setStatus('Открываю Google Docs и вставляю переписку…');
  try {
    await exportToDoc('ARCHIVER_EXPORT_NEW_DOC');
    setStatus('Готово. Переписка вставлена в новый Google Doc.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('newDoc').disabled = false;
  }
};

$('activeDoc').onclick = async () => {
  $('activeDoc').disabled = true;
  setStatus('Вставляю переписку в открытый Google Doc…');
  try {
    await exportToDoc('ARCHIVER_EXPORT_ACTIVE_DOC');
    setStatus('Готово. Переписка вставлена в открытый Google Doc.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('activeDoc').disabled = false;
  }
};

$('userName').oninput = e => saveSettings({ userName: e.target.value });
$('assistantName').oninput = e => saveSettings({ assistantName: e.target.value });
$('alignUserRight').onchange = e => saveSettings({ alignUserRight: e.target.checked });
$('includeReasoning').onchange = e => saveSettings({ includeReasoning: e.target.checked });
$('palette').onchange = e => saveSettings({ palette: e.target.value });

(async () => {
  try {
    const settings = await loadSettings();
    $('userName').value = settings.userName;
    $('assistantName').value = settings.assistantName;
    $('alignUserRight').checked = settings.alignUserRight;
    $('includeReasoning').checked = settings.includeReasoning;
    $('palette').value = settings.palette;
    applyPalette(settings.palette);
    const result = await getState();
    if (result?.job && ['starting', 'running', 'paused'].includes(result.job.status)) startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
})();
