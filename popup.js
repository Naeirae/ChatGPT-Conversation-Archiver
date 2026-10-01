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

const PHASE_LABELS = {
  top: 'Этап 1/3 · Загружаю начало',
  walk: 'Этап 2/3 · Собираю к зафиксированному концу',
  finalizing: 'Этап 3/3 · Сохраняю локальный архив',
  paused: 'Сбор приостановлен'
};

function renderCaptureProgress(job, running) {
  const box = $('captureProgress');
  if (!box) return;
  box.classList.toggle('hidden', !running);
  if (!running) return;

  $('capturePhase').textContent = PHASE_LABELS[job?.phase] || 'Сбор переписки';
  const parts = [];
  parts.push((job?.count || 0) + ' сообщений');
  if (job?.startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
    parts.push(seconds + ' с');
  }
  if (job?.iteration) parts.push('проход ' + job.iteration);
  $('captureMeta').textContent = parts.join(' · ');
}
function renderRunLog(job) {
  const box = $('runLog');
  if (!box) return;
  box.classList.toggle('hidden', !job);
  if (!job) return;

  const statusLabels = {
    starting: 'Запуск',
    running: 'Идёт',
    paused: 'Пауза',
    done: 'Завершён',
    error: 'Ошибка',
    cancelled: 'Отменён'
  };
  $('runLogTitle').textContent = statusLabels[job.status] || job.status || 'Последний запуск';

  const meta = [];
  meta.push(job.captureMode === 'continue' ? 'продолжение' : 'полный сбор');
  if (job.phase) meta.push(PHASE_LABELS[job.phase] || job.phase);
  meta.push((job.count || 0) + ' собрано');
  if (job.draftCount) meta.push(job.draftCount + ' в черновике');
  $('runLogMeta').textContent = meta.join(' · ');
  $('runLogMessage').textContent = job.message || '';
}

function renderDraft(draft) {
  const box = $('draft');
  if (!box) return;
  box.classList.toggle('hidden', !draft);
  if (!draft) return;
  $('draftTitle').textContent = draft.title || 'Незавершённый проход';
  $('draftMeta').textContent =
    (draft.messageCount || 0) + ' сообщений · ' + (draft.imageCount || 0) + ' изображений';
}


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
  const draft = state.draft;
  const running = job && ['starting', 'running', 'paused'].includes(job.status);
  const done = job?.status === 'done' && archive;

  $('capture').disabled = Boolean(running);
  $('capture').textContent = running ? 'Сбор идет в фоне…' : 'Собрать текущий чат';
  $('continue').classList.toggle('hidden', running || !state.canContinue);
  $('continue').disabled = Boolean(running);
  $('cancel').classList.toggle('hidden', !running);
  renderCaptureProgress(job, running);
  renderRunLog(job);
  renderDraft(draft);

  $('archive').classList.toggle('hidden', !archive);
  $('archiveTitle').textContent = archive?.title || '';
  $('archiveMeta').textContent = archive
    ? `${archive.messageCount || 0} сообщений · ${archive.imageCount || 0} изображений`
    : '';

  // A failed new capture must not hide or disable the previously completed
  // local archive. Export is disabled only while a capture is actively running.
  $('newDoc').disabled = Boolean(running || !archive);
  $('activeDoc').disabled = Boolean(running || !archive);

  if (running) {
    setStatus(job.message || 'Сбор идет в фоне…');
  } else if (job?.status === 'error') {
    const attempted = Number(job.count || 0);
    const saved = Number(archive?.messageCount || 0);
    const attemptText = attempted
      ? `Текущий запуск остановился после ${attempted} собранных сообщений. Этот неполный проход не заменил архив.`
      : 'Текущий запуск завершился с ошибкой до сохранения нового архива.';
    const savedText = archive
      ? ` Последний завершенный локальный архив: ${saved} сообщений.`
      : ' Завершенного локального архива пока нет.';
    setStatus(attemptText + savedText + ' ' + (job.message || ''), true);
  } else if (job?.status === 'cancelled') {
    const attempted = Number(job.count || 0);
    setStatus(attempted
      ? `Сбор отменен. В текущем проходе было собрано ${attempted} сообщений; завершенный локальный архив не изменен.`
      : 'Сбор отменен. Завершенный локальный архив не изменен.');
  } else if (done) {
    const added = archive.lastCaptureMode === 'continue' ? ` · +${archive.lastCaptureAddedCount || 0} новых` : '';
    setStatus(`Готово: ${archive.messageCount || 0} сообщений${added}, ${archive.imageCount || 0} изображений. Сохранено локально в Chrome.`);
  } else if (archive) {
    setStatus(`Локальный архив: ${archive.messageCount || 0} сообщений, ${archive.imageCount || 0} изображений.`);
  } else {
    setStatus('Готово.');
  }
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
    render({
      ...state,
      job: result.job,
      archive: state?.archive || null,
      draft: null
    });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('capture').disabled = false;
  }
};

$('continue').onclick = async () => {
  $('continue').disabled = true;
  setStatus('Ищу конец сохраненного архива в фоновой вкладке…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_CONTINUE_CURRENT' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить архив.');
    render({
      ...state,
      job: result.job,
      archive: state?.archive || null,
      draft: null,
      canContinue: true
    });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('continue').disabled = false;
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
$('copyArchive').onclick = async () => {
  $('copyArchive').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_COPY_ARCHIVE',
      archiveId: state?.archive?.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось скопировать архив.');
    setStatus('Архив скопирован: ' + (result.count || 0) + ' сообщений.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('copyArchive').disabled = false;
  }
};

$('copyDraft').onclick = async () => {
  $('copyDraft').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_COPY_DRAFT',
      draftId: state?.draft?.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось скопировать черновик.');
    setStatus('Черновик скопирован: ' + (result.count || 0) + ' сообщений.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('copyDraft').disabled = false;
  }
};

$('runLog').ondblclick = async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_COPY_RUN_LOG' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось скопировать лог.');
    setStatus('Лог последнего запуска скопирован.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
};


$('newDoc').onclick = async () => {
  $('newDoc').disabled = true;
  setStatus('Открываю Google Docs и вставляю переписку…');
  try {
    const result = await exportToDoc('ARCHIVER_EXPORT_NEW_DOC');
    setStatus(`Готово. В новый Google Doc вставлено ${result.addedCount || 0} сообщений.`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('newDoc').disabled = false;
  }
};

$('activeDoc').onclick = async () => {
  $('activeDoc').disabled = true;
  setStatus('Проверяю, что уже вставлено в этот Google Doc…');
  try {
    const result = await exportToDoc('ARCHIVER_EXPORT_ACTIVE_DOC');
    if (result.noChanges) {
      setStatus('В этом Google Doc уже есть все сообщения из локального архива.');
    } else if (result.exportMode === 'delta') {
      setStatus(`Готово. В конец документа добавлено ${result.addedCount || 0} новых сообщений.`);
    } else {
      setStatus(`Готово. В документ вставлен полный архив: ${result.addedCount || 0} сообщений.`);
    }
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
