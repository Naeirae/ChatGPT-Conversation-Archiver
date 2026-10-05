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
  captureTarget: 'copy'
};

const INTERFACE_PALETTES = new Set([
  'ocean', 'cobalt', 'sky', 'violet', 'rose',
  'amber', 'forest', 'graphite', 'midnight',
  'gradient-ocean', 'gradient-sunset', 'gradient-mint', 'gradient-violet',
  'custom'
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
  if (job?.navigationHighWater && job?.phase === 'walk') {
    parts.push('минимум найдено: ' + Number(job.navigationHighWater || 0));
    parts.push('хронологически: ' + Number(job.chronologicalCount ?? job.count ?? 0));
  } else {
    parts.push((job?.count || 0) + ' сообщений');
  }
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
          : job.captureMode === 'images'
            ? 'добор изображений'
            : job.captureMode === 'retry-walk'
              ? 'повтор только прохода вниз'
              : 'полный сбор'
  );
  if (job.captureTarget) meta.push(captureTargetLabel(job.captureTarget));
  if (job.phase) meta.push(PHASE_LABELS[job.phase] || job.phase);
  meta.push((job.count || 0) + ' собрано');
  if (job.draftCount) meta.push(job.draftCount + ' в незавершённом проходе');
  $('runLogMeta').textContent = meta.join(' · ');
  $('runLogMessage').textContent = job.message || '';
}

function renderDraft(draft) {
  const box = $('draft');
  if (!box) return;
  box.classList.toggle('hidden', !draft);
  if (!draft) return;
  $('draftTitle').textContent = 'Сбор не завершён' + (draft.title ? ' · ' + draft.title : '');
  $('draftMeta').textContent =
    (draft.messageCount || 0) + ' сообщений · ' + (draft.imageCount || 0) + ' изображений';
}

function renderUnfinishedPasses(items = []) {
  const list = $('unfinishedPassesList');
  const count = $('unfinishedPassesCount');
  if (!list || !count) return;

  const rows = Array.isArray(items) ? items : [];
  count.textContent = String(rows.length);
  list.textContent = '';

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Сохранённых незавершённых проходов нет.';
    list.appendChild(empty);
    return;
  }

  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const head = document.createElement('div');
    head.className = 'history-item-head';

    const title = document.createElement('div');
    title.className = 'history-item-title';
    title.textContent = item.title || 'Незавершённый проход';

    const status = document.createElement('div');
    status.className = 'history-item-status error';
    status.textContent = item.capturePhase || 'оборван';

    head.append(title, status);

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    const when = item.capturedAt ? new Date(item.capturedAt).toLocaleString('ru-RU') : '—';
    const parts = [
      when,
      (item.messageCount || 0) + ' сообщений',
      (item.imageCount || 0) + ' изображений'
    ];
    if (item.navigationHighWater) parts.push('контрольный минимум: ' + item.navigationHighWater);
    if (item.hasBoundary) parts.push('нижняя метка сохранена');
    meta.textContent = parts.join(' · ');

    const actions = document.createElement('div');
    actions.className = 'actions';

    const view = document.createElement('button');
    view.textContent = 'Просмотреть';
    view.onclick = async () => {
      const url = chrome.runtime.getURL('unfinished.html?passId=' + encodeURIComponent(item.id));
      await chrome.tabs.create({ url });
    };

    const copy = document.createElement('button');
    copy.textContent = 'Скопировать';
    copy.onclick = async () => {
      const result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_COPY_UNFINISHED_PASS',
        passId: item.id
      });
      if (!result?.ok) {
        setStatus(result?.error || 'Не удалось скопировать незавершённый проход.', true);
        return;
      }
      setStatus('Незавершённый проход скопирован: ' + (result.count || 0) + ' сообщений.');
    };

    const remove = document.createElement('button');
    remove.className = 'danger-outline';
    remove.textContent = 'Удалить';
    remove.onclick = async () => {
      if (!confirm('Удалить этот сохранённый незавершённый проход?')) return;
      const result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_DELETE_UNFINISHED_PASS',
        passId: item.id
      });
      if (!result?.ok) {
        setStatus(result?.error || 'Не удалось удалить незавершённый проход.', true);
        return;
      }
      await getState();
      setStatus('Незавершённый проход удалён.');
    };

    actions.append(view, copy, remove);
    row.append(head, meta, actions);
    list.appendChild(row);
  }
}


function renderSavedArchives(items = []) {
  const list = $('savedArchivesList');
  const count = $('savedArchivesCount');
  if (!list || !count) return;
  const rows = Array.isArray(items) ? items : [];
  count.textContent = String(rows.length);
  list.textContent = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Сохранённых архивов пока нет.';
    list.appendChild(empty);
    return;
  }
  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'archive-link-row';

    const main = document.createElement('div');
    main.className = 'archive-link-main';
    const title = document.createElement('div');
    title.className = 'archive-link-title';
    title.textContent = item.title || 'Архив ChatGPT';
    const meta = document.createElement('div');
    meta.className = 'archive-link-meta';
    const parts = [];
    if (item.messageCount != null) parts.push(item.messageCount + ' сообщений');
    if (item.updatedAt) {
      try { parts.push(new Date(item.updatedAt).toLocaleString('ru-RU')); } catch (_) {}
    }
    meta.textContent = parts.join(' · ');
    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'archive-link-actions';

    const resume = document.createElement('button');
    resume.className = 'archive-link-open';
    resume.type = 'button';
    resume.textContent = 'Продолжить';
    resume.disabled = Boolean(state?.job && ['starting', 'running', 'paused'].includes(state.job.status));
    resume.onclick = async () => {
      resume.disabled = true;
      setStatus('Открываю сохранённый чат и ищу место продолжения…');
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'ARCHIVER_CONTINUE_SAVED_ARCHIVE',
          archiveId: item.id,
          captureTarget: $('captureTarget').value
        });
        if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить сохранённый чат.');
        render({ ...state, job: result.job });
        startPolling();
      } catch (error) {
        setStatus(error.message || String(error), true);
        resume.disabled = false;
      }
    };
    actions.appendChild(resume);

    if (item.docUrl) {
      const open = document.createElement('a');
      open.className = 'archive-link-open';
      open.href = item.docUrl;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Google Doc ↗';
      actions.appendChild(open);
    }

    row.append(main, actions);
    list.appendChild(row);
  }
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
    sync: 'Восстановление',
    images: 'Добор изображений',
    'retry-walk': 'Повтор прохода вниз'
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
    '--bg', '--bg-gradient', '--panel', '--text', '--muted',
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
    root.style.setProperty('--bg-gradient', 'linear-gradient(145deg,' + background + ' 0%,' + mixHex(accent, background, 0.10) + ' 52%,' + background + ' 100%)');
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
  return value === 'copy' ? 'в фоновой вкладке' : 'в текущей вкладке';
}

function updateCaptureTargetHint(value) {
  $('captureTargetHint').textContent = value === 'copy'
    ? 'Сбор идёт в отдельной вкладке.'
    : 'Сбор идёт в этой вкладке.';
  const info = $('captureInfoText');
  if (info) {
    info.textContent = value === 'copy'
      ? 'Архиватор откроет отдельную вкладку с этим чатом, физически прокрутит его от начала до зафиксированного конца и сохранит сообщения. Текущую вкладку можно не трогать.'
      : 'Архиватор физически прокрутит этот чат в текущей вкладке. Пока идёт сбор, лучше не прокручивать страницу вручную.';
  }
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
  const draft = state.unfinishedPass || state.draft || null;
  const running = job && ['starting', 'running', 'paused'].includes(job.status);
  const activelyRunning = job && ['starting', 'running'].includes(job.status);
  const paused = job?.status === 'paused';
  const done = job?.status === 'done' && archive;

  renderCaptureState(job);
  renderHistory(state.history || []);
  renderUnfinishedPasses(state.unfinishedPasses || []);
  renderSavedArchives(state.savedArchives || []);
  $('unfinishedPassesPanel')?.classList.toggle('has-items', Boolean((state.unfinishedPasses || []).length));

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

  const recoverableDraft = Boolean(
    draft &&
    job?.status === 'error' &&
    job?.recoveryAvailable &&
    job?.captureTabId != null
  );
  $('openFailedCapture').classList.toggle('hidden', !recoverableDraft);
  $('resumeFailedCapture').classList.toggle('hidden', !recoverableDraft);
  $('resumeFailedCapture').disabled = Boolean(running || !recoverableDraft);
  $('draftRecoveryHint').classList.toggle('hidden', !draft);
  $('deleteDraft').disabled = Boolean(running || !draft);

  $('archive').classList.toggle('hidden', !archive);
  $('archiveTitle').textContent = archive?.title || '';
  $('archiveMeta').textContent = archive
    ? (`${archive.messageCount || 0} сообщений · ${archive.imageCount || 0} изображений` +
      (archive.imageCount ? ` · ${archive.imageBinaryReady || 0} подготовлено · ${archive.imageBinaryFailed || 0} ошибок` : '') +
      (archive.lastImageRecoveredCount ? ` · последний добор +${archive.lastImageRecoveredCount}` : ''))
    : '';

  // A failed new capture must not hide or disable the previously completed
  // local archive. Export is disabled only while a capture is actively running.
  $('newDoc').disabled = Boolean(running || !archive);
  $('activeDoc').disabled = Boolean(running || !archive);
  $('openPlanner').disabled = Boolean(running || !archive);
  $('recoverImages').disabled = Boolean(running || !archive || !state.canContinue);
  $('deleteArchive').disabled = Boolean(running || !archive);
  $('patchRecoveredImages').disabled = Boolean(
    running ||
    !archive ||
    !state.linkedDoc?.url ||
    !(archive.recoveredImagePendingPatchCount || archive.lastImageRecoveredCount)
  );

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
  } else if (job?.status === 'done' && job?.captureMode === 'images') {
    const recovered = Number(job.imageRecoveredCount || archive?.lastImageRecoveredCount || 0);
    setStatus(
      recovered
        ? `Добор картинок завершён: найдено ${recovered} новых. Локальный архив обновлён.`
        : 'Добор картинок завершён: новых изображений не найдено.'
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
      unfinishedPass: null
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
      unfinishedPass: null,
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
      unfinishedPass: null,
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
      unfinishedPass: null,
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
    } else if (previousMode === 'images') {
      setStatus('Повторяю добор картинок в обычном режиме…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_RECOVER_IMAGES_CURRENT',
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
      unfinishedPass: null
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
$('recoverImages').onclick = async () => {
  if (!state?.archive) {
    setStatus('Сначала нужен локальный архив этого чата.', true);
    return;
  }
  $('recoverImages').disabled = true;
  setStatus('Повторно прохожу чат и добираю только изображения…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_RECOVER_IMAGES_CURRENT',
      captureTarget: $('captureTarget').value
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось запустить добор изображений.');
    render({
      ...state,
      job: result.job,
      archive: state?.archive || null,
      unfinishedPass: null,
      canContinue: true
    });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('recoverImages').disabled = false;
  }
};

$('patchRecoveredImages').onclick = async () => {
  if (!state?.archive) {
    setStatus('Нет локального архива для довставки картинок.', true);
    return;
  }
  if (!state?.linkedDoc?.url) {
    setStatus('У этого чата нет связанного Google Doc.', true);
    return;
  }

  $('patchRecoveredImages').disabled = true;
  setStatus('Ищу сообщения в связанном Google Doc и довставляю только добранные картинки…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_PATCH_RECOVERED_IMAGES',
      archiveId: state.archive.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось довставить изображения.');
    if (result.noChanges) {
      setStatus('Новых добранных картинок для этого Google Doc нет.');
    } else {
      setStatus(
        `Довставка завершена: ${result.inserted || 0} изображений вставлено` +
        (result.failed ? `, ${result.failed} не вставлено.` : '.')
      );
    }
    await getState();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('patchRecoveredImages').disabled = false;
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

$('openFailedCapture').onclick = async () => {
  $('openFailedCapture').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_FOCUS_FAILED_CAPTURE_TAB' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось открыть вкладку сбора.');
    setStatus('Рабочая вкладка открыта. При необходимости домотайте её ближе к месту обрыва, затем нажмите «Найти стык и продолжить».');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('openFailedCapture').disabled = false;
  }
};

$('resumeFailedCapture').onclick = async () => {
  $('resumeFailedCapture').disabled = true;
  try {
    setStatus('Возвращаю сохранённую рабочую вкладку к началу без пересчёта сообщений; затем повторю только проход вниз…');
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_RESUME_FAILED_CAPTURE' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось повторить хронологический проход.');
    await getState();
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('resumeFailedCapture').disabled = false;
  }
};

$('deleteDraft').onclick = async () => {
  const draft = state?.draft;
  if (!draft) return;
  if (!confirm('Удалить этот незавершённый проход? Сохранённая рабочая вкладка этого прохода тоже будет закрыта.')) return;

  $('deleteDraft').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_DELETE_UNFINISHED_PASS',
      passId: draft.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось удалить незавершённый проход.');
    await getState();
    setStatus('Незавершённый проход удалён.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('deleteDraft').disabled = false;
  }
};

$('deleteArchive').onclick = async () => {
  const archive = state?.archive;
  if (!archive) return;
  if (!confirm('Удалить этот локальный архив? Связанный Google Doc удалён не будет.')) return;

  $('deleteArchive').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_DELETE_ARCHIVE',
      archiveId: archive.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось удалить локальный архив.');
    await getState();
    setStatus('Локальный архив удалён. Связанный Google Doc, если он был, не изменён.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('deleteArchive').disabled = false;
  }
};

$('viewDraft').onclick = async () => {
  const passId = (state?.unfinishedPass || state?.draft)?.id;
  if (!passId) return;
  const url = chrome.runtime.getURL('unfinished.html?passId=' + encodeURIComponent(passId));
  await chrome.tabs.create({ url });
};

$('copyDraft').onclick = async () => {
  $('copyDraft').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_COPY_UNFINISHED_PASS',
      passId: (state?.unfinishedPass || state?.draft)?.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось скопировать незавершённый проход.');
    setStatus('Незавершённый проход скопирован: ' + (result.count || 0) + ' сообщений.');
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

$('captureInfoToggle').onclick = () => {
  const panel = $('captureInfo');
  const button = $('captureInfoToggle');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  button.setAttribute('aria-expanded', opening ? 'true' : 'false');
};

$('userName').oninput = e => saveSettings({ userName: e.target.value });
$('assistantName').oninput = e => saveSettings({ assistantName: e.target.value });
$('alignUserRight').onchange = e => saveSettings({ alignUserRight: e.target.checked });
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

async function refreshUpdateNotice() {
  const notice = $('updateNotice');
  if (!notice) return;
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_CHECK_UPDATE' }).catch(() => null);
  const available = Boolean(result?.ok && result.available);
  notice.classList.toggle('hidden', !available);
  if (available) {
    $('updateNoticeText').textContent = 'Доступно обновление ' + result.remoteVersion;
  }
}

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
    $('captureTarget').value = settings.captureTarget === 'current' ? 'current' : 'copy';
    updateCaptureTargetHint($('captureTarget').value);
    renderInterfaceAppearanceControls(settings);
    applyInterfaceAppearance(settings);
    await refreshUpdateNotice();
    const result = await getState();
    if (result?.linkedDoc?.url && !$('docUrl').value) $('docUrl').value = result.linkedDoc.url;
    if (result?.job && ['starting', 'running', 'paused'].includes(result.job.status)) startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
})();
