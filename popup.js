const $ = id => document.getElementById(id);
let pollTimer = null;
let state = null;

const DEFAULT_INTERFACE_APPEARANCE = {
  palette: 'ocean',
  fontPreset: 'system',
  fontCustom: '',
  colors: {
    accent: '#1769e0',
    background: '#f4f8ff',
    panel: '#ffffff',
    text: '#12233f'
  }
};

const DEFAULT_SETTINGS = {
  userName: '',
  assistantName: '',
  palette: 'ocean',
  interfaceAppearance: DEFAULT_INTERFACE_APPEARANCE,
  alignUserRight: true,
  includeReasoning: false,
  captureTarget: 'copy'
};

const INTERFACE_PALETTES = new Set([
  'ocean', 'cobalt', 'sky', 'violet', 'rose',
  'amber', 'forest', 'graphite', 'midnight', 'custom'
]);

const INTERFACE_FONT_STACKS = {
  system: 'Inter, "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  segoe: '"Segoe UI", system-ui, sans-serif',
  arial: 'Arial, sans-serif',
  verdana: 'Verdana, sans-serif',
  tahoma: 'Tahoma, sans-serif',
  georgia: 'Georgia, serif',
  consolas: 'Consolas, "Courier New", monospace'
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
  meta.push(
    job.captureMode === 'compare'
      ? 'сверка с локальным архивом'
      : job.captureMode === 'sync'
        ? 'восстановление по Google Doc'
        : job.captureMode === 'continue'
          ? 'продолжение'
          : 'полный сбор'
  );
  if (job.captureTarget) meta.push(captureTargetLabel(job.captureTarget));
  if (job.phase) meta.push(PHASE_LABELS[job.phase] || job.phase);
  meta.push((job.count || 0) + ' собрано');
  if (job.reasoningBlockCount) meta.push(job.reasoningBlockCount + ' блоков размышлений');
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


function renderHistory(history = []) {
  const list = $('captureHistory');
  const count = $('historyCount');
  if (!list || !count) return;

  const items = Array.isArray(history) ? history : [];
  count.textContent = items.length + (items.length === 1 ? ' запуск' : (items.length >= 2 && items.length <= 4 ? ' запуска' : ' запусков'));
  list.textContent = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'История появится после завершённых, остановленных или ошибочных запусков.';
    list.appendChild(empty);
    return;
  }

  const statusLabels = {
    done: 'Завершён',
    error: 'Ошибка',
    cancelled: 'Остановлен'
  };
  const modeLabels = {
    full: 'Полный сбор',
    continue: 'Добор нового',
    compare: 'Сверка',
    sync: 'Восстановление'
  };

  for (const item of items.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const head = document.createElement('div');
    head.className = 'history-item-head';

    const title = document.createElement('div');
    title.className = 'history-item-title';
    title.textContent = modeLabels[item.captureMode] || item.captureMode || 'Сбор';

    const status = document.createElement('div');
    status.className = 'history-item-status ' + (item.status || '');
    status.textContent = statusLabels[item.status] || item.status || '—';

    head.append(title, status);

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    const when = item.finishedAt || item.startedAt;
    const time = when ? new Date(when).toLocaleString('ru-RU') : '—';
    const parts = [time, captureTargetLabel(item.captureTarget), (item.count || 0) + ' сообщений'];
    if (item.addedCount) parts.push('+' + item.addedCount + ' новых');
    meta.textContent = parts.join(' · ');

    row.append(head, meta);

    if (item.message) {
      const message = document.createElement('div');
      message.className = 'history-item-message';
      message.textContent = item.message;
      row.appendChild(message);
    }

    list.appendChild(row);
  }
}

function renderCaptureState(job) {
  const badge = $('captureStateBadge');
  if (!badge) return;

  badge.className = 'state-badge';
  if (!job) {
    badge.textContent = 'Готово';
    return;
  }

  const labels = {
    starting: 'Запуск',
    running: 'Сбор идёт',
    paused: 'Пауза',
    done: 'Готово',
    error: 'Ошибка',
    cancelled: 'Остановлен'
  };
  badge.textContent = labels[job.status] || job.status || 'Готово';
  if (job.status === 'running' || job.status === 'starting') badge.classList.add('running');
  else if (job.status === 'paused') badge.classList.add('paused');
  else if (job.status === 'done') badge.classList.add('done');
  else if (job.status === 'error') badge.classList.add('error');
}

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
}

function mixHex(foreground, background, foregroundWeight = 0.5) {
  const fg = normalizeHex(foreground, '#000000').slice(1);
  const bg = normalizeHex(background, '#ffffff').slice(1);
  const weight = Math.max(0, Math.min(1, Number(foregroundWeight) || 0));
  const channel = offset => Math.round(
    parseInt(fg.slice(offset, offset + 2), 16) * weight +
    parseInt(bg.slice(offset, offset + 2), 16) * (1 - weight)
  ).toString(16).padStart(2, '0');
  return '#' + channel(0) + channel(2) + channel(4);
}

function isDarkHex(value) {
  const hex = normalizeHex(value, '#ffffff').slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

function normalizeInterfaceAppearance(settings = {}) {
  const raw = settings.interfaceAppearance || {};
  const legacyPalette = raw.palette || settings.palette || DEFAULT_INTERFACE_APPEARANCE.palette;
  const palette = INTERFACE_PALETTES.has(legacyPalette)
    ? legacyPalette
    : DEFAULT_INTERFACE_APPEARANCE.palette;
  return {
    ...DEFAULT_INTERFACE_APPEARANCE,
    ...raw,
    palette,
    colors: {
      ...DEFAULT_INTERFACE_APPEARANCE.colors,
      ...(raw.colors || {})
    }
  };
}

function customFontStack(appearance) {
  if (appearance.fontPreset !== 'custom') {
    return INTERFACE_FONT_STACKS[appearance.fontPreset] || INTERFACE_FONT_STACKS.system;
  }
  const clean = String(appearance.fontCustom || '')
    .trim()
    .replace(/[;{}]/g, '')
    .replace(/"/g, '\"');
  return clean
    ? '"' + clean + '", "Segoe UI", system-ui, sans-serif'
    : INTERFACE_FONT_STACKS.system;
}

function applyInterfaceAppearance(settings = {}) {
  const appearance = normalizeInterfaceAppearance(settings);
  const root = document.documentElement;
  root.dataset.palette = appearance.palette;
  root.style.setProperty('--font-ui', customFontStack(appearance));

  const customVars = [
    '--bg', '--panel', '--text', '--muted',
    '--accent', '--accent-2', '--soft', '--border', '--shadow'
  ];
  for (const name of customVars) root.style.removeProperty(name);

  if (appearance.palette === 'custom') {
    const accent = normalizeHex(appearance.colors.accent, DEFAULT_INTERFACE_APPEARANCE.colors.accent);
    const background = normalizeHex(appearance.colors.background, DEFAULT_INTERFACE_APPEARANCE.colors.background);
    const panel = normalizeHex(appearance.colors.panel, DEFAULT_INTERFACE_APPEARANCE.colors.panel);
    const text = normalizeHex(appearance.colors.text, DEFAULT_INTERFACE_APPEARANCE.colors.text);
    const dark = isDarkHex(background);

    root.style.setProperty('--bg', background);
    root.style.setProperty('--panel', panel);
    root.style.setProperty('--text', text);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-2', mixHex(accent, dark ? '#ffffff' : '#001a4d', 0.78));
    root.style.setProperty('--soft', mixHex(accent, background, 0.12));
    root.style.setProperty('--border', mixHex(accent, background, 0.24));
    root.style.setProperty('--muted', mixHex(text, background, 0.58));
    root.style.setProperty('--shadow', '0 14px 36px ' + mixHex(accent, background, 0.18) + '55');
    root.style.colorScheme = dark ? 'dark' : 'light';
  } else {
    root.style.colorScheme = appearance.palette === 'midnight' ? 'dark' : 'light';
  }
}

function updateInterfaceControlVisibility() {
  const palette = $('interfacePalette')?.value || 'ocean';
  const fontPreset = $('interfaceFontPreset')?.value || 'system';
  $('interfaceCustomColors')?.classList.toggle('hidden', palette !== 'custom');
  $('interfaceFontCustomWrap')?.classList.toggle('hidden', fontPreset !== 'custom');
}

function readInterfaceAppearanceControls() {
  return {
    palette: $('interfacePalette').value,
    fontPreset: $('interfaceFontPreset').value,
    fontCustom: $('interfaceFontCustom').value.trim(),
    colors: {
      accent: $('interfaceAccent').value,
      background: $('interfaceBackground').value,
      panel: $('interfacePanel').value,
      text: $('interfaceText').value
    }
  };
}

function renderInterfaceAppearanceControls(settings) {
  const appearance = normalizeInterfaceAppearance(settings);
  $('interfacePalette').value = appearance.palette;
  $('interfaceFontPreset').value = appearance.fontPreset;
  $('interfaceFontCustom').value = appearance.fontCustom || '';
  $('interfaceAccent').value = normalizeHex(
    appearance.colors.accent,
    DEFAULT_INTERFACE_APPEARANCE.colors.accent
  );
  $('interfaceBackground').value = normalizeHex(
    appearance.colors.background,
    DEFAULT_INTERFACE_APPEARANCE.colors.background
  );
  $('interfacePanel').value = normalizeHex(
    appearance.colors.panel,
    DEFAULT_INTERFACE_APPEARANCE.colors.panel
  );
  $('interfaceText').value = normalizeHex(
    appearance.colors.text,
    DEFAULT_INTERFACE_APPEARANCE.colors.text
  );
  updateInterfaceControlVisibility();
}

function previewInterfaceAppearance() {
  applyInterfaceAppearance({
    interfaceAppearance: readInterfaceAppearanceControls()
  });
}

function captureTargetLabel(value) {
  return value === 'copy' ? 'фоновый режим' : 'обычный режим';
}

function updateCaptureTargetHint(value) {
  $('captureTargetHint').textContent = value === 'copy'
    ? 'По умолчанию. Отдельная рабочая вкладка кратко откроется для загрузки, затем фокус вернется в исходный чат; сбор продолжится в фоне.'
    : 'Резервный режим. Архиватор физически прокручивает этот чат; до завершения лучше его не трогать.';
}

async function loadSettings() {
  const result = await chrome.storage.local.get('archiverSettings');
  const merged = { ...DEFAULT_SETTINGS, ...(result.archiverSettings || {}) };
  merged.interfaceAppearance = normalizeInterfaceAppearance(merged);
  return merged;
}

async function saveSettings(patch, noticeId = 'settingsSaved') {
  const current = await loadSettings();
  const next = { ...current, ...patch };

  if (patch.interfaceAppearance) {
    next.interfaceAppearance = normalizeInterfaceAppearance({
      ...next,
      interfaceAppearance: {
        ...current.interfaceAppearance,
        ...patch.interfaceAppearance,
        colors: {
          ...current.interfaceAppearance.colors,
          ...(patch.interfaceAppearance.colors || {})
        }
      }
    });
    // Keep the short-lived legacy key in sync so downgrading does not lose
    // the selected preset. Export logic never depends on this key.
    next.palette = next.interfaceAppearance.palette;
  }

  await chrome.storage.local.set({ archiverSettings: next });
  applyInterfaceAppearance(next);

  if (noticeId) {
    const target = $(noticeId);
    if (target) {
      target.textContent = 'Сохранено';
      saveSettings.timers ||= {};
      clearTimeout(saveSettings.timers[noticeId]);
      saveSettings.timers[noticeId] = setTimeout(() => {
        target.textContent = '';
      }, 900);
    }
  }
}

function render(data) {
  state = data || {};
  const job = state.job;
  const archive = state.archive;
  const draft = state.draft;
  const running = job && ['starting', 'running', 'paused'].includes(job.status);
  const activelyRunning = job && ['starting', 'running'].includes(job.status);
  const paused = job?.status === 'paused';
  const done = job?.status === 'done' && archive;

  renderCaptureState(job);
  renderHistory(state.history || []);

  $('capture').disabled = Boolean(running);
  $('capture').textContent = running
    ? (job?.captureTarget === 'copy' ? 'Сбор идет в рабочей копии…' : 'Сбор идет в текущей вкладке…')
    : 'Собрать заново';
  $('continue').disabled = Boolean(running || !state.canContinue);
  $('compareArchive').disabled = Boolean(running || !state.canContinue);
  $('syncDoc').disabled = Boolean(running);
  $('docUrl').disabled = Boolean(running);
  $('captureTarget').disabled = Boolean(running);

  $('pauseCapture').classList.toggle('hidden', !activelyRunning);
  $('resumeCapture').classList.toggle('hidden', !paused);
  $('resumeCapture').disabled = Boolean(paused && job?.pauseReason && job.pauseReason !== 'user');
  $('cancel').classList.toggle('hidden', !running);
  $('resetCapture').disabled = Boolean(running || !job);
  $('clearHistory').disabled = Boolean(running || !(state.history || []).length);

  const compared = job?.status === 'done' && job?.captureMode === 'compare';
  $('compareResult').textContent = compared
    ? (Number(job.addedCount || 0) > 0
        ? 'Новых сообщений относительно локального архива: ' + Number(job.addedCount || 0) + '.'
        : 'Новых сообщений относительно локального архива нет.')
    : '';

  $('linkedDocHint').textContent = state.linkedDoc?.url
    ? 'Связанный документ найден. Его ссылку можно заменить на другую только для этого запуска.'
    : 'Связанного Google Doc для этого чата сейчас нет.';
  const canRetryCurrent = Boolean(
    !running &&
    job?.status === 'error' &&
    job?.captureTarget === 'copy'
  );
  $('retryCurrent').classList.toggle('hidden', !canRetryCurrent);
  if (!running && !$('docUrl').value && state.linkedDoc?.url) {
    $('docUrl').value = state.linkedDoc.url;
  }
  renderCaptureProgress(job, running);
  renderRunLog(job);
  renderDraft(draft);

  $('archive').classList.toggle('hidden', !archive);
  $('archiveTitle').textContent = archive?.title || '';
  $('archiveMeta').textContent = archive
    ? (`${archive.messageCount || 0} сообщений · ${archive.imageCount || 0} изображений` +
      (archive.reasoningBlockCount ? ` · ${archive.reasoningBlockCount} блоков размышлений` : '') +
      (archive.imageCount ? ` · ${archive.imageBinaryReady || 0} подготовлено · ${archive.imageBinaryFailed || 0} ошибок` : ''))
    : '';

  // A failed new capture must not hide or disable the previously completed
  // local archive. Export is disabled only while a capture is actively running.
  $('newDoc').disabled = Boolean(running || !archive);
  $('activeDoc').disabled = Boolean(running || !archive);
  $('openPlanner').disabled = Boolean(running || !archive);

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
  } else if (job?.status === 'done' && job?.captureMode === 'compare') {
    const added = Number(job.addedCount || 0);
    setStatus(
      added
        ? `Сверка завершена: ${added} новых сообщений относительно локального архива. Архив не изменён.`
        : 'Сверка завершена: новых сообщений относительно локального архива нет. Архив не изменён.'
    );
  } else if (done) {
    const added = archive.lastCaptureMode === 'continue' || archive.lastCaptureMode === 'sync'
      ? ` · +${archive.lastCaptureAddedCount || 0} новых`
      : '';
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

async function exportToDoc(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить в Google Docs.');
  return result;
}

$('capture').onclick = async () => {
  $('capture').disabled = true;
  const captureTarget = $('captureTarget').value;
  setStatus(captureTarget === 'copy'
    ? 'Запускаю сбор в рабочей копии…'
    : 'Запускаю сбор в текущей вкладке…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CAPTURE_CURRENT',
      captureTarget
    });
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

$('compareArchive').onclick = async () => {
  if (!state?.canContinue) {
    setStatus('Для сверки нужен локальный архив этого чата. Сначала нажмите «Собрать заново».', true);
    return;
  }

  $('compareArchive').disabled = true;
  setStatus('Сверяю текущий чат с локальным архивом и считаю новые сообщения…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_COMPARE_CURRENT',
      captureTarget: $('captureTarget').value
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сверить чат с локальным архивом.');
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
    $('compareArchive').disabled = false;
  }
};

$('continue').onclick = async () => {
  $('continue').disabled = true;
  setStatus(
    $('docUrl').value.trim()
      ? 'Ищу последний сохранённый стык; новые сообщения добавлю в указанный Google Doc…'
      : 'Ищу последний сохранённый стык и добираю только новое…'
  );
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CONTINUE_CURRENT',
      docUrl: $('docUrl').value.trim(),
      captureTarget: $('captureTarget').value
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить архив.');
    render({
      ...state,
      job: result.job,
      archive: state?.archive || null,
      draft: null,
      canContinue: true,
      linkedDoc: result.linkedDoc || state?.linkedDoc || null
    });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('continue').disabled = false;
  }
};

$('syncDoc').onclick = async () => {
  const docUrl = $('docUrl').value.trim();
  if (!docUrl) {
    setStatus('Для восстановления точки продолжения вставьте ссылку на Google Doc.', true);
    return;
  }

  $('syncDoc').disabled = true;
  $('continue').disabled = true;
  $('capture').disabled = true;
  $('compareArchive').disabled = true;
  setStatus('Читаю Google Doc как резервную точку продолжения и ищу его хвост в текущем чате…');

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_SYNC_CURRENT',
      docUrl,
      captureTarget: $('captureTarget').value
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось восстановить стык по Google Doc.');
    render({
      ...state,
      job: result.job,
      archive: result.archive || state?.archive || null,
      draft: null,
      canContinue: true,
      linkedDoc: result.linkedDoc || state?.linkedDoc || null
    });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('syncDoc').disabled = false;
    $('continue').disabled = false;
    $('capture').disabled = false;
    $('compareArchive').disabled = !state?.canContinue;
  }
};

$('retryCurrent').onclick = async () => {
  const previousMode = state?.job?.captureMode || 'full';
  $('retryCurrent').disabled = true;
  $('captureTarget').value = 'current';
  updateCaptureTargetHint('current');

  try {
    let result;
    if (previousMode === 'compare') {
      setStatus('Повторяю сверку с локальным архивом в обычном режиме…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_COMPARE_CURRENT',
        captureTarget: 'current'
      });
    } else if (previousMode === 'sync') {
      const docUrl = $('docUrl').value.trim();
      if (!docUrl) throw new Error('Для восстановления по Google Doc нужна ссылка.');
      setStatus('Повторяю восстановление стыка в обычном режиме…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_SYNC_CURRENT',
        docUrl,
        captureTarget: 'current'
      });
    } else if (previousMode === 'continue') {
      setStatus('Повторяю продолжение в обычном режиме…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_CONTINUE_CURRENT',
        docUrl: $('docUrl').value.trim(),
        captureTarget: 'current'
      });
    } else {
      setStatus('Повторяю полный сбор в обычном режиме…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_CAPTURE_CURRENT',
        captureTarget: 'current'
      });
    }

    if (!result?.ok) throw new Error(result?.error || 'Не удалось запустить обычный режим.');
    render({
      ...state,
      job: result.job,
      archive: state?.archive || null,
      draft: null
    });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('retryCurrent').disabled = false;
  }
};

$('pauseCapture').onclick = async () => {
  $('pauseCapture').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_PAUSE_CAPTURE',
      jobId: state?.job?.jobId
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось поставить сбор на паузу.');
    await getState();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('pauseCapture').disabled = false;
  }
};

$('resumeCapture').onclick = async () => {
  $('resumeCapture').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_RESUME_CAPTURE',
      jobId: state?.job?.jobId
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить сбор.');
    await getState();
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('resumeCapture').disabled = false;
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

$('resetCapture').onclick = async () => {
  $('resetCapture').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_RESET_CAPTURE_STATE' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сбросить состояние запуска.');
    await getState();
    setStatus('Состояние последнего запуска сброшено. Завершённый архив и история сохранены.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('resetCapture').disabled = false;
  }
};

$('clearHistory').onclick = async () => {
  $('clearHistory').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_CLEAR_RUN_HISTORY' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось очистить историю.');
    await getState();
    setStatus('История запусков очищена.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('clearHistory').disabled = false;
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

$('copyRunLog').onclick = async () => {
  $('copyRunLog').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_COPY_RUN_LOG' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось скопировать лог.');
    setStatus('Лог последнего запуска скопирован.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('copyRunLog').disabled = false;
  }
};


$('openPlanner').onclick = async () => {
  $('openPlanner').disabled = true;
  try {
    const archiveId = state?.archive?.id || '';
    const url = chrome.runtime.getURL(
      'planner.html' + (archiveId ? '?archiveId=' + encodeURIComponent(archiveId) : '')
    );
    await chrome.tabs.create({ url });
    setStatus('Открыла разметку архива в отдельной вкладке.');
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('openPlanner').disabled = false;
  }
};

$('newDoc').onclick = async () => {
  $('newDoc').disabled = true;
  setStatus('Открываю Google Docs и вставляю переписку…');
  try {
    const result = await exportToDoc('ARCHIVER_EXPORT_NEW_DOC');
    const imagePart = (result.imageInsertedCount || result.imageFailedCount)
      ? ` Изображения: ${result.imageInsertedCount || 0} вставлено, ${result.imageFailedCount || 0} ошибок.`
      : '';
    setStatus(`Готово. В новый Google Doc вставлено ${result.addedCount || 0} сообщений.` + imagePart);
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
      const imagePart = (result.imageInsertedCount || result.imageFailedCount)
        ? ` Изображения: ${result.imageInsertedCount || 0} вставлено, ${result.imageFailedCount || 0} ошибок.`
        : '';
      setStatus(`Готово. В конец документа добавлено ${result.addedCount || 0} новых сообщений.` + imagePart);
    } else {
      const imagePart = (result.imageInsertedCount || result.imageFailedCount)
        ? ` Изображения: ${result.imageInsertedCount || 0} вставлено, ${result.imageFailedCount || 0} ошибок.`
        : '';
      setStatus(`Готово. В документ вставлен полный архив: ${result.addedCount || 0} сообщений.` + imagePart);
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
$('captureTarget').onchange = e => {
  updateCaptureTargetHint(e.target.value);
  saveSettings({ captureTarget: e.target.value }, null);
};

async function saveInterfaceAppearanceFromControls() {
  const appearance = readInterfaceAppearanceControls();
  await saveSettings(
    { interfaceAppearance: appearance, palette: appearance.palette },
    'interfaceSettingsSaved'
  );
  renderInterfaceAppearanceControls({ interfaceAppearance: appearance });
}

$('interfacePalette').onchange = async () => {
  updateInterfaceControlVisibility();
  previewInterfaceAppearance();
  await saveInterfaceAppearanceFromControls();
};

$('interfaceFontPreset').onchange = async () => {
  updateInterfaceControlVisibility();
  previewInterfaceAppearance();
  await saveInterfaceAppearanceFromControls();
};

for (const id of ['interfaceAccent', 'interfaceBackground', 'interfacePanel', 'interfaceText']) {
  $(id).oninput = previewInterfaceAppearance;
  $(id).onchange = () => saveInterfaceAppearanceFromControls().catch(error => {
    setStatus(error.message || String(error), true);
  });
}

$('interfaceFontCustom').oninput = () => {
  previewInterfaceAppearance();
  clearTimeout(saveInterfaceAppearanceFromControls.timer);
  saveInterfaceAppearanceFromControls.timer = setTimeout(() => {
    saveInterfaceAppearanceFromControls().catch(error => {
      setStatus(error.message || String(error), true);
    });
  }, 240);
};

$('resetInterfaceAppearance').onclick = async () => {
  const appearance = {
    ...DEFAULT_INTERFACE_APPEARANCE,
    colors: { ...DEFAULT_INTERFACE_APPEARANCE.colors }
  };
  renderInterfaceAppearanceControls({ interfaceAppearance: appearance });
  await saveSettings(
    { interfaceAppearance: appearance, palette: appearance.palette },
    'interfaceSettingsSaved'
  );
};

$('localVersion').textContent = chrome.runtime.getManifest().version || '—';

$('reloadExtension').addEventListener('click', () => {
  setStatus('Перезагружаю расширение…');
  setTimeout(() => chrome.runtime.reload(), 120);
});

(async () => {
  try {
    const settings = await loadSettings();
    $('userName').value = settings.userName;
    $('assistantName').value = settings.assistantName;
    $('alignUserRight').checked = settings.alignUserRight;
    $('includeReasoning').checked = settings.includeReasoning;
    $('captureTarget').value = settings.captureTarget === 'current' ? 'current' : 'copy';
    updateCaptureTargetHint($('captureTarget').value);
    renderInterfaceAppearanceControls(settings);
    applyInterfaceAppearance(settings);
    const result = await getState();
    if (result?.linkedDoc?.url && !$('docUrl').value) $('docUrl').value = result.linkedDoc.url;
    if (result?.job && ['starting', 'running', 'paused'].includes(result.job.status)) startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
})();
