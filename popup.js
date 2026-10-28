const $ = id => document.getElementById(id);
let pollTimer = null;
let state = null;

const DEFAULT_INTERFACE_APPEARANCE = {
  palette: 'ocean',
  fontPreset: 'segoe',
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

const INTERFACE_FONT_PRESETS = new Set([
  'segoe', 'arial', 'verdana', 'tahoma', 'georgia', 'consolas'
]);

const INTERFACE_FONT_STACKS = {
  segoe: '"Segoe UI", system-ui, sans-serif',
  arial: 'Arial, sans-serif',
  verdana: 'Verdana, sans-serif',
  tahoma: 'Tahoma, sans-serif',
  georgia: 'Georgia, serif',
  consolas: 'Consolas, "Courier New", monospace'
};

const PHASE_LABELS = {
  boundary: 'Подготовка · Ищу нижнюю границу',
  top: 'Этап 1/3 · Первый проход вверх',
  walk: 'Этап 2/3 · Сверяю сверху вниз',
  finalizing: 'Этап 3/3 · Завершаю архив',
  paused: 'Сбор приостановлен'
};

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return totalSeconds + ' с';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return minutes + ' мин ' + seconds + ' с';
}

function renderCaptureProgress(job, running) {
  const box = $('captureProgress');
  if (!box) return;
  box.classList.toggle('hidden', !running);
  if (!running) return;

  const isFragment = job?.captureMode === 'fragment';
  const fragmentPhaseLabels = {
    top: 'Фрагмент · Ищу отмеченное начало',
    walk: 'Фрагмент · Собираю до отмеченного конца',
    finalizing: 'Фрагмент · Сохраняю выбранные сообщения',
    paused: 'Сбор фрагмента приостановлен'
  };
  const imageHydrationActive = job?.phase === 'finalizing' &&
    Number(job?.imageBinaryTotal || 0) > 0;
  $('capturePhase').textContent = imageHydrationActive
    ? 'Этап 3/3 · Загружаю картинки'
    : isFragment
      ? (fragmentPhaseLabels[job?.phase] || 'Сбор выбранного фрагмента')
      : (PHASE_LABELS[job?.phase] || 'Сбор переписки');
  const parts = [];
  const resumed = ['resume-draft', 'retry-walk'].includes(job?.captureMode || '') &&
    Number(job?.resumeBaseCount || job?.draftCount || 0) > 0;
  if (resumed) {
    const base = Number(job?.resumeBaseCount || 0);
    const savedNow = Number(job?.draftCount || base || 0);
    parts.push('было сохранено: ' + base);
    parts.push('сохранено сейчас: ' + savedNow);
    if (Number(job?.count || 0)) {
      parts.push(
        job?.captureMode === 'retry-walk'
          ? 'подтверждено в повторном проходе: ' + Number(job.count || 0)
          : 'текущий проход: ' + Number(job.count || 0)
      );
    }
  } else if (job?.comparisonComplete && Number(job?.firstPassCount || 0)) {
    const first = Number(job.firstPassCount || 0);
    const second = Number(job.secondPassCount || 0);
    parts.push('первый проход: ' + first);
    parts.push('второй проход: ' + second);
    parts.push(job?.passCountMatch ? 'количество совпало' : 'количество не совпало');
    if (Number(job?.reconciledInsertedCount || 0)) {
      parts.push('добрано сообщений: ' + Number(job.reconciledInsertedCount || 0));
    }
  } else if (job?.navigationHighWater && job?.phase === 'walk') {
    parts.push('первый проход: ' + Number(job.navigationHighWater || 0));
    parts.push('второй проход сейчас: ' + Number(job.chronologicalCount ?? job.count ?? 0));
  } else {
    parts.push((job?.count || 0) + ' сообщений');
  }
  const imageTotal = Number(job?.imageCount || 0);
  const imageReady = Number(job?.imageBinaryReady || 0);
  const imageFailed = Number(job?.imageBinaryFailed || 0);
  const imageProcessed = Number(job?.imageBinaryProcessed || 0);
  const imageHydrationTotal = Number(job?.imageBinaryTotal || 0);
  if (imageTotal || imageHydrationTotal || job?.phase === 'finalizing') {
    if (imageHydrationTotal) {
      parts.push('картинки: ' + imageProcessed + '/' + imageHydrationTotal);
    } else if (imageTotal) {
      parts.push('картинки готовы: ' + imageReady + '/' + imageTotal);
    }
    if (job?.phase === 'finalizing' && imageReady && imageHydrationTotal) {
      parts.push('готово: ' + imageReady);
    }
    if (imageFailed) parts.push('не удалось: ' + imageFailed);
  }
  if (job?.startedAt) {
    parts.push(formatDuration(Date.now() - job.startedAt));
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
    job.captureMode === 'fragment'
      ? 'сбор выбранного фрагмента'
      : job.captureMode === 'compare'
      ? 'сверка с локальным архивом'
      : job.captureMode === 'sync'
        ? 'восстановление по документу Google Docs'
        : job.captureMode === 'continue'
          ? 'продолжение'
          : job.captureMode === 'reconcile'
            ? 'сверка архива'
            : job.captureMode === 'images-draft'
              ? 'сверка изображений незавершённой части'
              : job.captureMode === 'images'
                ? 'сверка и добор изображений'
                : job.captureMode === 'retry-walk'
                  ? 'повтор только прохода вниз'
                  : 'полный сбор'
  );
  if (job.captureTarget) meta.push(captureTargetLabel(job.captureTarget));
  if (job.phase) meta.push(PHASE_LABELS[job.phase] || job.phase);
  meta.push((job.count || 0) + ' собрано');
  if (Number(job.imageCount || 0)) {
    meta.push(
      Number(job.imageCount || 0) + ' изображений · готово ' +
      Number(job.imageBinaryReady || 0)
    );
  }
  if (job.draftCount) meta.push(job.draftCount + ' в незавершённом сборе');
  if (job.startedAt && (job.finishedAt || !['starting', 'running', 'paused'].includes(job.status))) {
    meta.push(formatDuration((job.finishedAt || Date.now()) - job.startedAt));
  }
  $('runLogMeta').textContent = meta.join(' · ');
  $('runLogMessage').textContent = job.message || '';
}

function unfinishedPhaseLabel(phase = '', mode = '') {
  if (phase === 'top' && ['resume-draft', 'retry-walk'].includes(mode)) {
    return 'восстанавливает место продолжения';
  }
  return {
    top: 'идёт к началу',
    walk: 'сохраняется сверху вниз',
    finalizing: 'готовится итоговый архив',
    paused: 'приостановлен'
  }[phase] || 'не завершён';
}

function renderUnfinishedPasses(items = []) {
  const list = $('unfinishedPassesList');
  const count = $('unfinishedPassesCount');
  if (!list || !count) return;

  const rows = Array.isArray(items) ? items : [];
  count.textContent = String(rows.length);
  list.textContent = '';

  if (!rows.length) return;

  const busy = Boolean(state?.job && ['starting', 'running', 'paused'].includes(state.job.status));

  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'history-item unfinished-capture-row';

    const head = document.createElement('div');
    head.className = 'history-item-head';

    const title = document.createElement('div');
    title.className = 'history-item-title';
    title.textContent = item.title || 'Незавершённый сбор';

    const status = document.createElement('div');
    status.className = 'history-item-status';
    status.textContent = unfinishedPhaseLabel(item.capturePhase, item.captureMode);

    head.append(title, status);

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    const when = item.capturedAt ? new Date(item.capturedAt).toLocaleString('ru-RU') : '—';
    const parts = [
      when,
      Number(item.messageCount || 0) + ' сообщений',
      Number(item.imageCount || 0) + ' изображений',
      Number(item.imageBinaryReady || 0) + ' изображений подготовлено'
    ];
    if (item.hasBoundary) parts.push('конец чата зафиксирован');
    if (item.recoveryTabAvailable) parts.push('рабочая вкладка сохранена');
    meta.textContent = parts.join(' · ');

    let saveHint = null;
    if (!item.canExportCurrent) {
      saveHint = document.createElement('div');
      saveHint.className = 'unfinished-save-hint';
      saveHint.textContent = 'Сохранить в документ можно после начала прохода сверху вниз.';
    }

    let documentStatus = null;
    if (item.linkedDocUrl) {
      documentStatus = document.createElement('div');
      documentStatus.className = 'unfinished-document-status';
      const text = document.createElement('span');
      text.textContent = 'Текущая часть уже связана с документ Google Docs.';
      const link = document.createElement('a');
      link.href = item.linkedDocUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Открыть документ ↗';
      documentStatus.append(text, link);
    }

    const primaryActions = document.createElement('div');
    primaryActions.className = 'unfinished-primary-actions';

    const resume = document.createElement('button');
    resume.className = 'primary';
    resume.textContent = 'Продолжить';
    resume.disabled = busy;
    resume.onclick = async () => {
      resume.disabled = true;
      if (saveCurrent) saveCurrent.disabled = true;
      setStatus(
        item.recoveryTabAvailable
          ? 'Продолжаю сбор в сохранённой рабочей вкладке…'
          : 'Открываю исходный чат и восстанавливаю место продолжения…'
      );
      try {
        const passId = item.resumePassId || item.id;
        const result = item.resumeFromJob
          ? await chrome.runtime.sendMessage({
              type: 'ARCHIVER_RESUME_FAILED_CAPTURE'
            })
          : item.recoveryTabAvailable
            ? await chrome.runtime.sendMessage({
                type: 'ARCHIVER_RESUME_UNFINISHED_IN_SAVED_TAB',
                passId
              })
            : await chrome.runtime.sendMessage({
                type: 'ARCHIVER_RESUME_UNFINISHED_PASS',
                passId,
                captureTarget: $('captureTarget').value,
                resumeStrategy: 'fresh'
              });
        if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить сбор.');
        render({ ...state, job: result.job });
        startPolling();
      } catch (error) {
        setStatus(error.message || String(error), true);
        resume.disabled = false;
        if (saveCurrent) saveCurrent.disabled = false;
      }
    };
    primaryActions.appendChild(resume);

    const saveCurrent = document.createElement('button');
    saveCurrent.className = 'unfinished-save';
    saveCurrent.textContent = 'Сохранить текущую часть в документ Google Docs';
    saveCurrent.disabled = Boolean(busy || !item.canExportCurrent || !item.exportPassId);
    if (!item.canExportCurrent || !item.exportPassId) {
      saveCurrent.title = 'Сохранение станет доступно, когда начнётся проход сверху вниз и появится непрерывная сохранённая часть.';
    }
    saveCurrent.onclick = async () => {
      if (!item.canExportCurrent || !item.exportPassId) {
        setStatus('Сначала Архиватор должен начать сохранять чат сверху вниз. После первой сохранённой части эту кнопку можно будет использовать.');
        return;
      }
      saveCurrent.disabled = true;
      resume.disabled = true;
      setStatus('Сохраняю текущую собранную часть в документ Google Docs…');
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'ARCHIVER_EXPORT_UNFINISHED_NEW_DOC',
          passId: item.exportPassId
        });
        if (!result?.ok) {
          throw new Error(result?.error || 'Не удалось сохранить текущую часть в документ Google Docs.');
        }
        setStatus(
          'Текущая часть сохранена в документ Google Docs: ' +
          Number(result.exportedMessageCount || result.addedCount || item.exportMessageCount || 0) +
          ' сообщений.'
        );
        await getState();
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        saveCurrent.disabled = Boolean(
          state?.job && ['starting', 'running', 'paused'].includes(state.job.status)
        );
        resume.disabled = Boolean(
          state?.job && ['starting', 'running', 'paused'].includes(state.job.status)
        );
      }
    };
    primaryActions.appendChild(saveCurrent);

    const secondary = document.createElement('div');
    secondary.className = 'unfinished-secondary-actions';

    if (item.recoveryTabAvailable) {
      const openCapture = document.createElement('button');
      openCapture.textContent = 'Открыть рабочую вкладку';
      openCapture.onclick = async () => {
        const result = await chrome.runtime.sendMessage({
          type: 'ARCHIVER_FOCUS_UNFINISHED_RECOVERY_TAB',
          passId: item.resumePassId || item.id
        });
        if (!result?.ok) setStatus(result?.error || 'Не удалось открыть рабочую вкладку.', true);
      };
      secondary.appendChild(openCapture);
    }

    if (item.viewPassId) {
      const view = document.createElement('button');
      view.textContent = 'Просмотреть сохранённую часть';
      view.onclick = async () => {
        const url = chrome.runtime.getURL(
          'unfinished.html?passId=' + encodeURIComponent(item.viewPassId)
        );
        await chrome.tabs.create({ url });
      };
      secondary.appendChild(view);
    }

    if (item.canExportCurrent && item.exportPassId) {
      const reconcileSaved = document.createElement('button');
      reconcileSaved.textContent = 'Сверить сохранённую часть';
      reconcileSaved.onclick = async () => {
        reconcileSaved.disabled = true;
        setStatus('Сверяю сохранённую часть с локальным архивом…');
        try {
          const result = await chrome.runtime.sendMessage({
            type: 'ARCHIVER_RECONCILE_UNFINISHED_PASS',
            passId: item.exportPassId
          });
          if (!result?.ok) throw new Error(result?.error || 'Не удалось выполнить сверку.');
          setStatus(
            'Сверка завершена: восстановлено ' +
            Number(result.addedCount || 0) + ' сообщений; в архиве ' +
            Number(result.messageCount || 0) + '.'
          );
          await getState();
        } catch (error) {
          setStatus(error.message || String(error), true);
        } finally {
          reconcileSaved.disabled = false;
        }
      };
      secondary.appendChild(reconcileSaved);
    }

    if (item.copyPassId) {
      const copy = document.createElement('button');
      copy.textContent = 'Скопировать сохранённую часть';
      copy.onclick = async () => {
        const result = await chrome.runtime.sendMessage({
          type: 'ARCHIVER_COPY_UNFINISHED_PASS',
          passId: item.copyPassId
        });
        if (!result?.ok) {
          setStatus(result?.error || 'Не удалось скопировать сохранённую часть.', true);
          return;
        }
        setStatus('Скопировано сообщений: ' + Number(result.count || 0) + '.');
      };
      secondary.appendChild(copy);
    }

    const remove = document.createElement('button');
    remove.className = 'danger-outline';
    remove.textContent = item.resumeFromJob
      ? 'Убрать остановленный запуск из списка'
      : 'Удалить незавершённый сбор';
    remove.onclick = async () => {
      if (!confirm('Удалить сохранённые данные этого незавершённого сбора? Рабочая вкладка останется открытой.')) return;
      remove.disabled = true;
      setStatus('Удаляю сохранённые данные незавершённого сбора…');
      try {
        const result = item.resumeFromJob
          ? await chrome.runtime.sendMessage({ type: 'ARCHIVER_RESET_CAPTURE_STATE' })
          : await chrome.runtime.sendMessage({
              type: 'ARCHIVER_DELETE_UNFINISHED_GROUP',
              logicalGroupId: item.logicalGroupId || '',
              passIds: item.passIds || [item.id]
            });
        if (!result?.ok) throw new Error(result?.error || 'Не удалось убрать незавершённый сбор.');
        row.remove();
        count.textContent = String(list.children.length);
        setStatus('Сохранённые данные незавершённого сбора удалены. Рабочая вкладка не закрыта.');
        cachedUnfinishedGroups = null;
        void getState()
          .then(() => loadUnfinishedGroups())
          .catch(error => setStatus(error.message || String(error), true));
      } catch (error) {
        remove.disabled = false;
        setStatus(error.message || String(error), true);
      }
    };
    secondary.appendChild(remove);

    row.append(head, meta);
    if (saveHint) row.appendChild(saveHint);
    if (documentStatus) row.appendChild(documentStatus);
    row.append(primaryActions, secondary);
    list.appendChild(row);
  }
}

let detailedSavedArchives = null;

function withDetailedArchiveCounts(rows = []) {
  if (!Array.isArray(detailedSavedArchives)) return rows;
  const byId = new Map(detailedSavedArchives.map(item => [item.id, item]));
  return rows.map(item => {
    const detailed = byId.get(item.id);
    if (!detailed) return item;
    return {
      ...item,
      messageCount: Number.isFinite(item.messageCount) ? item.messageCount : detailed.messageCount,
      imageCount: Number.isFinite(item.imageCount) ? item.imageCount : detailed.imageCount,
      imageBinaryReady: Number.isFinite(item.imageBinaryReady) ? item.imageBinaryReady : detailed.imageBinaryReady,
      imageBinaryFailed: Number.isFinite(item.imageBinaryFailed) ? item.imageBinaryFailed : detailed.imageBinaryFailed
    };
  });
}

async function loadFastArchiveLibrary() {
  const response = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_SAVED_ARCHIVES_FAST' });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось загрузить библиотеку архивов.');
  renderSavedArchives(response.savedArchives || []);
}

async function hydrateSavedArchiveDetails() {
  const response = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_SAVED_ARCHIVES_DETAILS' });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось получить статистику архивов.');
  detailedSavedArchives = response.savedArchives || [];
  // Include legacy rows whose IDs existed in index/destinations but were
  // missing from the lightweight library registry.
  if (state) state.savedArchives = detailedSavedArchives;
  renderSavedArchives(detailedSavedArchives);
}

function renderSavedArchives(items = []) {
  const list = $('savedArchivesList');
  const count = $('savedArchivesCount');
  const notice = $('savedArchivesNotice');
  if (!list || !count) return;

  const rows = withDetailedArchiveCounts(Array.isArray(items) ? items : []);
  count.textContent = String(rows.length);
  list.textContent = '';

  const withoutDocument = rows.filter(item => !item.destination?.saved).length;
  if (notice) {
    notice.classList.toggle('hidden', !withoutDocument);
    notice.textContent = withoutDocument
      ? (withoutDocument === 1
          ? '1 чат сохранён локально без документа Google Docs.'
          : withoutDocument + ' чатов сохранены локально без документа Google Docs.')
      : '';
  }

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Сохранённых чатов пока нет.';
    list.appendChild(empty);
    return;
  }

  const busy = Boolean(state?.job && ['starting', 'running', 'paused'].includes(state.job.status));

  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'archive-link-row';

    const main = document.createElement('div');
    main.className = 'archive-link-main';

    const title = document.createElement('div');
    title.className = 'archive-link-title';
    title.textContent = item.isFragment && !/^Фрагмент\b/i.test(item.title || '')
      ? 'Фрагмент — ' + (item.title || 'Чат ChatGPT')
      : (item.title || 'Чат ChatGPT');

    const meta = document.createElement('div');
    meta.className = 'archive-link-meta';
    const parts = [
      (Number.isFinite(item.messageCount) ? item.messageCount : '…') + ' сообщений',
      (Number.isFinite(item.imageCount) ? item.imageCount : '…') + ' картинок'
    ];
    if (Number(item.imageCount || 0)) {
      parts.push('готово ' + Number(item.imageBinaryReady || 0) + '/' + Number(item.imageCount || 0));
    }
    if (item.capturedAt) {
      try { parts.push(new Date(item.capturedAt).toLocaleString('ru-RU')); } catch (_) {}
    }
    meta.textContent = parts.join(' · ');

    const destination = document.createElement('div');
    destination.className = 'archive-destination';
    const destinationText = document.createElement('span');
    if (item.docUrl || item.destination?.kind === 'google-doc') {
      destinationText.textContent = 'Google Doc создан';
    } else if (item.linkedDocUrl) {
      destinationText.textContent = 'Есть связанный Google Doc';
    } else {
      destinationText.textContent = 'Только локально';
    }
    destination.appendChild(destinationText);

    main.append(title, meta, destination);

    const actions = document.createElement('div');
    actions.className = 'archive-link-actions';

    const openArchive = document.createElement('button');
    openArchive.className = 'archive-link-open';
    openArchive.type = 'button';
    openArchive.textContent = 'Открыть';
    openArchive.disabled = busy;
    openArchive.onclick = async () => {
      openArchive.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'ARCHIVER_SELECT_SAVED_ARCHIVE',
          archiveId: item.id
        });
        if (!result?.ok) throw new Error(result?.error || 'Не удалось открыть сохранённый чат.');
        await getState();
        setStatus('Открыт локальный архив «' + (item.title || 'Чат ChatGPT') + '».');
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        openArchive.disabled = false;
      }
    };
    actions.appendChild(openArchive);

    // The archive planner is also the full local-message viewer. Open it by
    // archive ID, independently of current-chat URL or popup selection state.
    const viewPlanner = document.createElement('button');
    viewPlanner.className = 'archive-link-open';
    viewPlanner.type = 'button';
    viewPlanner.textContent = 'Просмотр и вкладки';
    viewPlanner.disabled = busy;
    viewPlanner.onclick = async () => {
      viewPlanner.disabled = true;
      try {
        const url = chrome.runtime.getURL(
          'planner.html?archiveId=' + encodeURIComponent(item.id)
        );
        await chrome.tabs.create({ url });
        setStatus('Открыт просмотр архива с разметкой вкладок.');
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        viewPlanner.disabled = false;
      }
    };
    actions.appendChild(viewPlanner);

    if (!item.isFragment && item.sourceUrl) {
      const continueSaved = document.createElement('button');
      continueSaved.className = 'archive-link-open';
      continueSaved.type = 'button';
      continueSaved.textContent = 'Продолжить';
      continueSaved.disabled = busy;
      continueSaved.onclick = async () => {
        continueSaved.disabled = true;
        setStatus('Открываю исходный чат и продолжаю с последнего сохранённого места…', false, true);
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
          continueSaved.disabled = false;
        }
      };
      actions.appendChild(continueSaved);
    }

    const docUrl = item.docUrl || item.destination?.url || item.linkedDocUrl || '';

    const saveToDoc = document.createElement('button');
    saveToDoc.className = 'archive-link-open';
    saveToDoc.type = 'button';
    saveToDoc.textContent = docUrl ? 'Обновить Google Doc' : 'В Google Doc';
    saveToDoc.disabled = busy;
    saveToDoc.onclick = async () => {
      saveToDoc.disabled = true;
      setStatus(
        docUrl
          ? 'Открываю Google Doc и проверяю сохранённый чат…'
          : 'Создаю Google Doc для сохранённого чата…',
        false,
        true
      );
      try {
        const result = await exportToDoc(
          docUrl ? 'ARCHIVER_EXPORT_LINKED_DOC' : 'ARCHIVER_EXPORT_NEW_DOC',
          { archiveId: item.id }
        );
        const imageAdded = Number(result.imageInsertedCount || 0) + Number(result.imageInlinePasteCount || 0);
        const imageFailed = Number(result.imageFailedCount || 0);
        setStatus(
          (docUrl ? 'Google Doc обновлён.' : 'Google Doc создан.') +
          ' Сообщений: ' + Number(result.addedCount || 0) + '.' +
          (imageAdded || imageFailed
            ? ' Картинки: добавлено ' + imageAdded +
              (imageFailed ? ', не удалось ' + imageFailed : '') + '.'
            : '')
        );
        await getState();
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        saveToDoc.disabled = false;
      }
    };
    actions.appendChild(saveToDoc);

    if (docUrl) {
      const docLink = document.createElement('a');
      docLink.className = 'archive-link-open';
      docLink.href = docUrl;
      docLink.target = '_blank';
      docLink.rel = 'noopener noreferrer';
      docLink.textContent = 'Google Doc ↗';
      actions.appendChild(docLink);
    }

    if (item.sourceUrl) {
      const sourceLink = document.createElement('a');
      sourceLink.className = 'archive-link-open archive-link-subtle';
      sourceLink.href = item.sourceUrl;
      sourceLink.target = '_blank';
      sourceLink.rel = 'noopener noreferrer';
      sourceLink.textContent = 'Чат ↗';
      actions.appendChild(sourceLink);
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
  count.textContent = String(items.length);
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
    images: 'Сверка и добор изображений',
    'images-draft': 'Сверка изображений незавершённой части',
    reconcile: 'Сверка',
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
    if (item.startedAt && item.finishedAt) parts.push(formatDuration(item.finishedAt - item.startedAt));
    if (item.addedCount) parts.push('+' + item.addedCount + ' новых');
    if (item.imageCount) {
      const ready = Number(item.imageBinaryReady || 0);
      const failed = Number(item.imageBinaryFailed || 0);
      parts.push(
        Number(item.imageCount || 0) + ' изображений' +
        (ready || failed ? ' · готово ' + ready + ' / не удалось ' + failed : '')
      );
    }
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

function setStatus(text, error = false, busy = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
  $('status').classList.toggle('busy', Boolean(busy && !error));
  $('status').setAttribute('aria-busy', busy && !error ? 'true' : 'false');
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
  const fontPreset = INTERFACE_FONT_PRESETS.has(raw.fontPreset)
    ? raw.fontPreset
    : DEFAULT_INTERFACE_APPEARANCE.fontPreset;
  return {
    ...DEFAULT_INTERFACE_APPEARANCE,
    ...raw,
    palette,
    fontPreset,
    fontCustom: '',
    colors: {
      ...DEFAULT_INTERFACE_APPEARANCE.colors,
      ...(raw.colors || {})
    }
  };
}

function customFontStack(appearance) {
  return INTERFACE_FONT_STACKS[appearance.fontPreset] || INTERFACE_FONT_STACKS.segoe;
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
  $('interfaceCustomColors')?.classList.toggle('hidden', palette !== 'custom');
}

function readInterfaceAppearanceControls() {
  return {
    palette: $('interfacePalette').value,
    fontPreset: $('interfaceFontPreset').value,
    fontCustom: '',
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
  $('interfaceFontCustom').value = '';
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
  const running = job && ['starting', 'running', 'paused'].includes(job.status);
  const activelyRunning = job && ['starting', 'running'].includes(job.status);
  const paused = job?.status === 'paused';
  const done = job?.status === 'done' && archive;
  const hasManualRange = Boolean(state?.captureRange?.start && state?.captureRange?.end);

  $('captureTitle').textContent = hasManualRange ? 'Основной архив по отметкам' : 'Собрать чат';
  $('capture').textContent = 'Собрать чат';
  if (!running && hasManualRange) {
    $('fragmentHint').textContent =
      'Начало и конец основного архива отмечены. Оставьте начало видимым и нажмите «Собрать отмеченный диапазон». Этот режим не открывает копию и не ищет верх автоматически.';
  }

  renderCaptureState(job);
  if (Array.isArray(state.history)) renderHistory(state.history);
  renderUnfinishedPasses(state.unfinishedPasses || []);
  if (Array.isArray(state.savedArchives)) renderSavedArchives(state.savedArchives);
  const hasUnfinished = Boolean(
    (state.unfinishedPasses || []).length ||
    Number(state.unfinishedDraftCount || 0) > 0 ||
    state.unfinishedDraftCount === null ||
    state.hasUnfinishedRecovery
  );
  const unfinishedPanel = $('unfinishedPassesPanel');
  unfinishedPanel?.classList.toggle('hidden', !hasUnfinished);
  unfinishedPanel?.classList.toggle('has-items', hasUnfinished);
  if (!state.unfinishedDetailsLoaded) {
    const draftCount = state.unfinishedDraftCount;
    $('unfinishedPassesCount').textContent =
      draftCount == null ? '…' : String(draftCount) + ' черновиков';
  }
  const showDrafts = $('loadUnfinishedPasses');
  if (showDrafts && !unfinishedGroupLoading) {
    showDrafts.textContent = state.unfinishedDetailsLoaded
      ? 'Обновить черновики' : 'Показать черновики';
  }
  const isFragmentRun = job?.captureMode === 'fragment' && running;
  const captureHeading = document.querySelector('.capture-card .section-heading strong');
  if (captureHeading) captureHeading.textContent = isFragmentRun
    ? 'Собирается архив по отметкам'
    : (hasManualRange ? 'Основной архив по отметкам' : 'Собрать чат');
  $('captureFragment').disabled = Boolean(running);
  $('markFragment').disabled = Boolean(running);
  $('clearMarkers').disabled = Boolean(running);
  $('openMarkingTab').disabled = Boolean(running);
  $('capture').disabled = Boolean(running);
  $('capture').textContent = running
    ? (isFragmentRun
        ? 'Собирается основной архив по отметкам…'
        : (job?.captureTarget === 'copy' ? 'Сбор идёт в фоновой вкладке…' : 'Сбор идёт в текущей вкладке…'))
    : 'Разметить диапазон';
  $('continue').disabled = Boolean(running || !state.canContinue);
  $('syncDoc').disabled = Boolean(running);
  $('docUrl').disabled = Boolean(running);
  $('captureTarget').disabled = Boolean(running);

  // Keep the pause/resume controls next to the capture heading, not below
  // the long capture form where they can be invisible during startup.
  const captureControls = $('captureControls');
  const captureHeadingRow = document.querySelector('.capture-card .section-heading');
  if (captureControls && captureHeadingRow && captureControls.previousElementSibling !== captureHeadingRow) {
    captureHeadingRow.after(captureControls);
  }
  // Keep pause visible even while the worker is preparing a new run.
  const canConfirmTop = Boolean(
    ['starting', 'running'].includes(job?.status || '') &&
    job?.phase === 'top' &&
    !job?.boundarySearchActive &&
    job?.captureTabId != null &&
    ['full', 'images', 'images-draft', 'reconcile', 'retry-walk'].includes(job?.captureMode || '')
  );
  $('confirmTop').classList.add('hidden');
  $('confirmTop').disabled = true;
  $('pauseCapture').classList.toggle('hidden', !activelyRunning);
  $('pauseCapture').textContent = job?.status === 'starting' ? 'Пауза (запуск)' : 'Пауза';
  $('captureControls').classList.toggle('hidden', !running);
  $('resumeCapture').classList.toggle('hidden', !paused);
  $('resumeCapture').disabled = Boolean(paused && job?.pauseReason && job.pauseReason !== 'user');
  $('cancel').classList.toggle('hidden', !running);
  $('resetCapture').disabled = Boolean(running || !job);
  $('clearHistory').disabled = Boolean(running || !(state.history || []).length);

  $('compareResult').textContent = '';

  $('linkedDocHint').textContent = state.linkedDoc?.url
    ? 'Связанный документ найден. Его ссылку можно заменить на другую только для этого запуска.'
    : 'Связанного документа Google Docs для этого чата сейчас нет.';
  const canRetryCurrent = Boolean(
    !running &&
    !hasUnfinished &&
    job?.status === 'error' &&
    job?.captureTarget === 'copy'
  );
  $('retryCurrent').textContent = 'Начать заново в текущей вкладке';
  $('retryCurrent').classList.toggle('hidden', !canRetryCurrent);
  $('dismissFailedRun').classList.toggle(
    'hidden',
    Boolean(running || hasUnfinished || job?.status !== 'error')
  );
  $('dismissFailedRun').disabled = Boolean(running);
  if (!running && !$('docUrl').value && state.linkedDoc?.url) {
    $('docUrl').value = state.linkedDoc.url;
  }
  renderCaptureProgress(job, running);
  renderRunLog(job);

  $('archive').classList.toggle('hidden', !archive);
  $('archiveTitle').textContent = archive?.title || '';
  $('archiveMeta').textContent = archive
    ? ((archive.messageCount || 0) + ' сообщений · ' + (archive.imageCount || 0) + ' изображений' +
      ' · картинки готовы ' + (archive.imageBinaryReady || 0) + '/' + (archive.imageCount || 0) +
      (archive.imageBinaryFailed ? ' · не удалось ' + archive.imageBinaryFailed : '') +
      (archive.lastImageRecoveredCount ? ' · добор изображений +' + archive.lastImageRecoveredCount : ''))
    : '';
  const linkedUrl = state.linkedDoc?.url || '';
  const archiveDestination = state.archiveDestination || null;
  const savedDocUrl = archiveDestination?.saved && archiveDestination?.kind === 'google-doc'
    ? (archiveDestination.url || '')
    : '';
  const completenessUnverified = archive?.captureVerification === 'unverified';
  $('archiveStateLabel').textContent = completenessUnverified
    ? 'Локальный архив · полнота не подтверждена'
    : (savedDocUrl ? 'Сохранён в документ Google Docs' : 'Чат сохранён');
  $('archiveStateHint').textContent = completenessUnverified
    ? 'Предыдущая версия Архиватора не проверяла весь проход от начала до конца'
    : (savedDocUrl
        ? 'локальная копия также сохранена для продолжения'
        : (linkedUrl ? 'локально · для переписки есть связанный документ' : 'локально в Chrome'));
  $('archiveDocStatus').textContent = completenessUnverified
    ? 'Этот архив сохранён локально, но его полнота не доказана. Экспорт перенесёт только фактически сохранённые сообщения. Для полной копии запустите сбор по отметкам заново.'
    : (savedDocUrl
        ? 'Этот локальный архив уже сохранён в документ Google Docs.'
        : linkedUrl
          ? 'Этот архив сохранён локально. Для переписки есть связанный документ: его можно обновить или создать новый документ.'
          : 'Этот архив сохранён локально. Можно создать для него новый документ Google Docs.');
  $('archiveDocLink').classList.toggle('hidden', !(savedDocUrl || linkedUrl));
  $('archiveDocLink').href = savedDocUrl || linkedUrl || '#';
  $('archiveDocLink').textContent = savedDocUrl
    ? 'Открыть документ Google Docs ↗'
    : 'Открыть связанный документ Google Docs ↗';

  // A failed new capture must not hide or disable the previously completed
  // local archive. Export is disabled only while a capture is actively running.
  $('newDoc').disabled = Boolean(running || !archive);
  $('activeDoc').textContent = linkedUrl
    ? 'Обновить Google Doc'
    : 'В открытый Google Doc';
  $('activeDoc').disabled = Boolean(running || !archive);
  $('openPlanner').disabled = Boolean(running || !archive);
  $('continueArchive').disabled = Boolean(running || !archive || !archive.sourceUrl);
  $('reconcileArchive').disabled = Boolean(running || !archive || !archive.sourceUrl);
  $('editCurrentDoc').disabled = Boolean(running || !archive || !archive.sourceUrl);
  $('currentDocUrl').value = linkedUrl || savedDocUrl || '';
  $('clearCurrentDocLink').classList.toggle('hidden', !linkedUrl);
  $('deleteArchive').disabled = Boolean(running || !archive);
  const canDeleteWithDoc = Boolean(archive && (savedDocUrl || linkedUrl));
  $('deleteArchiveAndDoc').classList.toggle('hidden', !canDeleteWithDoc);
  $('deleteArchiveAndDoc').disabled = Boolean(running || !canDeleteWithDoc);
  if (running) {
    setStatus(job.message || 'Сбор идет в фоне…');
  } else if (job?.status === 'error' && job?.captureMode === 'images-draft') {
    setStatus(
      'Сверка изображений незавершённой части остановилась. Исходная сохранённая часть не заменена. ' +
      (job.message || ''),
      true
    );
  } else if (job?.status === 'error') {
    const attempted = Number(job.count || 0);
    const attemptText = attempted
      ? `Сбор остановился после ${attempted} сообщений.`
      : 'Сбор остановился.';
    const nextText = hasUnfinished ? ' Незавершённый сбор можно продолжить ниже.' : '';
    setStatus(attemptText + nextText + ' ' + (job.message || ''), true);
  } else if (job?.status === 'cancelled' && job?.captureMode === 'images-draft') {
    setStatus('Сверка изображений остановлена. Сохранённая часть оставлена без замены.');
  } else if (job?.status === 'cancelled') {
    const attempted = Number(job.count || 0);
    setStatus(
      (attempted ? `Сбор остановлен после ${attempted} сообщений.` : 'Сбор остановлен.') +
      (hasUnfinished ? ' Сохранённую часть можно продолжить.' : '')
    );
  } else if (completenessUnverified) {
    setStatus(
      'Сохранено локально ' + Number(archive?.messageCount || 0) +
      ' сообщений. Полнота прежнего сбора не подтверждена; эти данные не следует считать всем чатом.',
      true
    );
  } else if (job?.status === 'done' && job?.captureMode === 'images-draft') {
    setStatus(
      job.message ||
      'Сверка изображений незавершённой части завершена. Сохранённый префикс обновлён.'
    );
  } else if (job?.status === 'done' && job?.captureMode === 'compare') {
    const added = Number(job.addedCount || 0);
    setStatus(
      added
        ? `Сверка завершена: ${added} новых сообщений относительно локального архива. Архив не изменён.`
        : 'Сверка завершена: новых сообщений относительно локального архива нет. Архив не изменён.'
    );
  } else if (job?.status === 'done' && job?.captureMode === 'reconcile') {
    const repaired = Number(job.addedCount || archive?.lastCaptureAddedCount || 0);
    const imageTotal = Number(archive?.imageCount || 0);
    const imageReady = Number(archive?.imageBinaryReady || 0);
    const imageFailed = Number(archive?.imageBinaryFailed || 0);
    setStatus(
      'Сверка завершена.' +
      (repaired ? ' Восстановлено сообщений: ' + repaired + '.' : ' Сообщения совпадают.') +
      (imageTotal ? ' Картинки: готово ' + imageReady + '/' + imageTotal +
        (imageFailed ? ', не удалось ' + imageFailed : '') + '.' : '')
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

let cachedUnfinishedGroups = null;
let unfinishedGroupLoading = false;

async function loadUnfinishedGroups() {
  if (unfinishedGroupLoading) return;
  const button = $('loadUnfinishedPasses');
  unfinishedGroupLoading = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Проверяю черновики…';
  }
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_UNFINISHED_GROUPS' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сверить черновики.');
    cachedUnfinishedGroups = result.unfinishedPasses || [];
    if (state) {
      render({
        ...state,
        unfinishedPasses: cachedUnfinishedGroups,
        unfinishedPass: result.unfinishedPass || null,
        unfinishedDetailsLoaded: true
      });
    }
  } catch (error) {
    setStatus(error?.message || String(error), true);
  } finally {
    unfinishedGroupLoading = false;
    if (button) button.disabled = false;
    if (button) button.textContent = cachedUnfinishedGroups
      ? 'Обновить черновики' : 'Показать черновики';
  }
}

$('loadUnfinishedPasses').onclick = () => { void loadUnfinishedGroups(); };

async function getState() {
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_STATE' });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось получить состояние.');
  if (cachedUnfinishedGroups) {
    result.unfinishedPasses = cachedUnfinishedGroups;
    result.unfinishedDetailsLoaded = true;
  }
  render(result);
  return result;
}

function mergeLiveUnfinished(rows = [], live = null) {
  const next = Array.isArray(rows) ? rows.map(item => ({ ...item })) : [];
  if (!live?.id) return next;

  const index = next.findIndex(item =>
    live.logicalGroupId &&
    item.logicalGroupId === live.logicalGroupId
  );

  if (index < 0) {
    next.unshift(live);
    return next;
  }

  const current = next[index];
  next[index] = {
    ...current,
    ...live,
    title: current.title || live.title,
    passIds: [...new Set([...(current.passIds || []), ...(live.passIds || [])])],
    messageCount: Math.max(Number(current.messageCount || 0), Number(live.messageCount || 0)),
    exportPassId: live.exportPassId || current.exportPassId || '',
    canExportCurrent: Boolean(live.canExportCurrent || current.canExportCurrent),
    exportMessageCount: Math.max(
      Number(current.exportMessageCount || 0),
      Number(live.exportMessageCount || 0)
    ),
    recoveryTabAvailable: Boolean(
      live.recoveryTabAvailable || current.recoveryTabAvailable
    ),
    recoveryTabId: live.recoveryTabId ?? current.recoveryTabId ?? null
  };
  return next;
}

async function getLiveState() {
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_LIVE_STATE' });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось получить состояние сбора.');

  const previousStatus = state?.job?.status || '';
  const nextState = {
    ...(state || {}),
    job: result.job || null,
    unfinishedPasses: mergeLiveUnfinished(
      state?.unfinishedPasses || [],
      result.unfinishedPass || null
    )
  };
  render(nextState);

  const nextStatus = result.job?.status || '';
  const wasActive = ['starting', 'running', 'paused'].includes(previousStatus);
  const isActive = ['starting', 'running', 'paused'].includes(nextStatus);
  if (wasActive && !isActive) {
    cachedUnfinishedGroups = null;
    return getState();
  }
  return result;
}

let stateRefreshPending = false;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (stateRefreshPending) return;
    stateRefreshPending = true;
    try {
      await getLiveState();
    } catch (_) {
      // Перезапуск фонового процесса не должен создавать параллельные опросы.
    } finally {
      stateRefreshPending = false;
    }
  }, 2500);
}

async function exportToDoc(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить в документ Google Docs.');
  return result;
}

$('fragmentToggle').onclick = () => {};

$('capture').onclick = async () => {
  const button = $('capture');
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_TOGGLE_MARKING_CURRENT'
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось включить разметку диапазона.');
    button.textContent = result.enabled ? 'Завершить разметку' : 'Разметить диапазон';
    $('fragmentHint').textContent = result.enabled
      ? 'Разметка включена: кликните по реплике и поставьте «Начало» или «Конец» на панели в чате.'
      : 'Разметка выключена. Для запуска оставьте отмеченное начало видимым.';
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
};

async function refreshBoundaryMarkingControl() {
  const button = $('markFragment');
  if (!button) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(tab.url || '')) {
    button.textContent = 'Отметить границы в текущей вкладке';
    return;
  }
  const current = await chrome.tabs.sendMessage(tab.id, {
    type: 'ARCHIVER_GET_FRAGMENT_SELECTION'
  }).catch(() => null);
  const enabled = Boolean(current?.ok && current.enabled);
  button.textContent = enabled
    ? 'Завершить разметку'
    : 'Отметить границы в текущей вкладке';
  if (enabled) {
    $('fragmentHint').textContent =
      'Разметка включена. Чтобы выйти, нажмите «Завершить разметку» здесь или на панели Архиватора в чате.';
  }
}

$('markFragment').onclick = async () => {
  const button = $('markFragment');
  button.disabled = true;
  try {
    const next = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_TOGGLE_MARKING_CURRENT'
    });
    if (!next?.ok) throw new Error(next?.error || 'Не удалось переключить режим разметки.');
    button.textContent = next.enabled ? 'Закончить разметку' : 'Отметить границы в текущей вкладке';
    $('fragmentHint').textContent = next.enabled
      ? 'Разметка включена. Закройте popup, кликните по нужной реплике и используйте постоянную панель «Начало / Конец».'
      : 'Режим разметки выключен. Выбранные границы сохранены.';
    if (!next.enabled) await getState().catch(() => {});
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
};

$('clearMarkers').onclick = async () => {
  const button = $('clearMarkers');
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CLEAR_MARKERS_CURRENT'
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сбросить отметки.');
    $('fragmentHint').textContent = 'Начало и конец сброшены.';
    await getState();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
};

$('openMarkingTab').onclick = async () => {
  const button = $('openMarkingTab');
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_OPEN_MARKING_TAB' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось открыть рабочую вкладку для разметки.');
    await saveSettings({ captureTarget: 'current' }, null);
    $('captureTarget').value = 'current';
    updateCaptureTargetHint('current');
    $('fragmentHint').textContent =
      'Рабочая вкладка открыта. Отметьте в ней «Конец», затем «Начало», оставьте начало видимым и нажмите «Собрать отмеченный диапазон».';
  } catch (error) {
    setStatus(error.message || String(error), true);
    button.disabled = false;
  }
};

$('captureFragment').onclick = async () => {
  $('captureFragment').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CAPTURE_FRAGMENT',
      captureTarget: 'current'
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось запустить сбор диапазона.');
    $('fragmentHint').textContent = 'Сбор отмеченного диапазона запущен.';
    startPolling();
  } catch (error) {
    $('fragmentHint').textContent = error.message || String(error);
    setStatus(error.message || String(error), true);
  } finally {
    $('captureFragment').disabled = false;
  }
};

$('copyFragment').onclick = async () => {
  $('copyFragment').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_COPY_SELECTED_FRAGMENT' });
    if (!result?.ok) throw new Error(result?.error || 'Фрагмент пока не собран.');
    $('fragmentHint').textContent = 'Скопировано реплик: ' + result.count + '.';
    setStatus('Фрагмент скопирован с форматированием.');
  } catch (error) {
    $('fragmentHint').textContent = error.message || String(error);
    setStatus(error.message || String(error), true);
  } finally {
    $('copyFragment').disabled = false;
  }
};

$('continue').onclick = async () => {
  $('continue').disabled = true;
  setStatus(
    $('docUrl').value.trim()
      ? 'Ищу последний сохранённый стык; новые сообщения добавлю в указанный документ Google Docs…'
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
    setStatus('Для восстановления точки продолжения вставьте ссылку на документ Google Docs.', true);
    return;
  }

  $('syncDoc').disabled = true;
  $('continue').disabled = true;
  $('capture').disabled = true;
  setStatus('Читаю документ Google Docs как резервную точку продолжения и ищу его хвост в текущем чате…');

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_SYNC_CURRENT',
      docUrl,
      captureTarget: $('captureTarget').value
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось восстановить стык по документу Google Docs.');
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
  }
};

$('retryCurrent').onclick = async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sameConversation = (a, b) => {
    try {
      return Boolean(a && b && new URL(a).origin === new URL(b).origin &&
        new URL(a).pathname === new URL(b).pathname);
    } catch (_) { return false; }
  };
  const latestUnfinished = (state?.unfinishedPasses || []).find(item =>
    sameConversation(item.sourceUrl, activeTab?.url)
  ) || null;
  $('retryCurrent').disabled = true;

  if (latestUnfinished?.id) {
    try {
      setStatus('Продолжаю незавершённый сбор…');
      const result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_RESUME_UNFINISHED_PASS',
        passId: latestUnfinished.id,
        captureTarget: $('captureTarget').value
      });
      if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить незавершённый сбор.');
      render({ ...state, job: result.job });
      startPolling();
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      $('retryCurrent').disabled = false;
    }
    return;
  }

  const previousMode = state?.job?.captureMode || 'full';
  $('captureTarget').value = 'current';
  updateCaptureTargetHint('current');

  try {
    let result;
    if (previousMode === 'sync') {
      const docUrl = $('docUrl').value.trim();
      if (!docUrl) throw new Error('Для восстановления по документу Google Docs нужна ссылка.');
      setStatus('Повторяю восстановление в текущей вкладке…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_SYNC_CURRENT',
        docUrl,
        captureTarget: 'current'
      });
    } else if (previousMode === 'continue') {
      setStatus('Повторяю продолжение в текущей вкладке…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_CONTINUE_CURRENT',
        docUrl: $('docUrl').value.trim(),
        captureTarget: 'current'
      });
    } else if (previousMode === 'reconcile') {
      setStatus('Повторяю сверку и добор сообщений в текущей вкладке…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_RECONCILE_CURRENT',
        captureTarget: 'current'
      });
    } else if (previousMode === 'images') {
      setStatus('Повторяю сверку и добор изображений в текущей вкладке…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_RECOVER_IMAGES_CURRENT',
        captureTarget: 'current'
      });
    } else {
      setStatus('Повторяю полный сбор в текущей вкладке…');
      result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_CAPTURE_CURRENT',
        captureTarget: 'current'
      });
    }

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
  } finally {
    $('retryCurrent').disabled = false;
  }
};

$('confirmTop').onclick = async () => {
  $('confirmTop').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CONFIRM_TOP',
      jobId: state?.job?.jobId
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось отметить начало переписки.');
    setStatus('Начало отмечено вручную. Архиватор переходит к сохранению сверху вниз…');
    await getState();
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('confirmTop').disabled = false;
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

$('dismissFailedRun').onclick = async () => {
  $('dismissFailedRun').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_RESET_CAPTURE_STATE' });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось убрать ошибочный запуск.');
    await getState();
    setStatus('Ошибочный запуск убран. Сохранённые черновики не удалены.');
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('dismissFailedRun').disabled = false;
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
$('reconcileArchive').onclick = async () => {
  if (!state?.archive) {
    setStatus('Сначала нужен локальный архив этого чата.', true);
    return;
  }
  $('reconcileArchive').disabled = true;
  setStatus('Открываю исходный чат и сверяю архив: сообщения и картинки…', false, true);
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_RECONCILE_SAVED_ARCHIVE',
      archiveId: state.archive.id,
      captureTarget: $('captureTarget').value
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось запустить сверку архива.');
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
    $('reconcileArchive').disabled = false;
  }
};

$('archiveDocLink').onclick = async event => {
  event.preventDefault();
  if (!state?.archive?.id || !state?.linkedDoc?.url) return;

  const link = $('archiveDocLink');
  link.setAttribute('aria-disabled', 'true');
  setStatus('Открываю и проверяю связанный документ Google Docs…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_OPEN_LINKED_DOC',
      archiveId: state.archive.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось открыть связанный документ Google Docs.');
    setStatus('Связанный документ Google Docs открыт.');
  } catch (error) {
    setStatus(error.message || String(error), true);
    await getState().catch(() => {});
  } finally {
    link.removeAttribute('aria-disabled');
  }
};

$('continueArchive').onclick = async () => {
  const archive = state?.archive;
  if (!archive?.id) {
    setStatus('Сначала нужен локальный архив.', true);
    return;
  }
  $('continueArchive').disabled = true;
  setStatus('Открываю исходный чат и продолжаю с последнего сохранённого места…', false, true);
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CONTINUE_SAVED_ARCHIVE',
      archiveId: archive.id,
      captureTarget: $('captureTarget').value
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить чат.');
    render({ ...state, job: result.job });
    startPolling();
  } catch (error) {
    setStatus(error.message || String(error), true);
    $('continueArchive').disabled = false;
  }
};

$('editCurrentDoc').onclick = () => {
  const editor = $('currentDocEditor');
  const nextOpen = editor.classList.contains('hidden');
  editor.classList.toggle('hidden', !nextOpen);
  $('editCurrentDoc').textContent = nextOpen ? 'Скрыть ссылку Google Doc' : 'Связать / сменить Google Doc';
  if (nextOpen) $('currentDocUrl').focus();
};

$('cancelCurrentDocEdit').onclick = () => {
  $('currentDocEditor').classList.add('hidden');
  $('editCurrentDoc').textContent = 'Связать / сменить Google Doc';
};

$('saveCurrentDocLink').onclick = async () => {
  const archive = state?.archive;
  const docUrl = $('currentDocUrl').value.trim();
  if (!archive?.id || !archive.sourceUrl) {
    setStatus('Не удалось определить локальный архив.', true);
    return;
  }
  if (!docUrl) {
    setStatus('Вставьте ссылку на Google Doc.', true);
    $('currentDocUrl').focus();
    return;
  }

  $('saveCurrentDocLink').disabled = true;
  setStatus('Проверяю и сохраняю ссылку на Google Doc…', false, true);
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_REPLACE_LINKED_DOC',
      archiveId: archive.id,
      sourceUrl: archive.sourceUrl,
      docUrl
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить ссылку Google Doc.');
    await getState();
    $('currentDocEditor').classList.add('hidden');
    $('editCurrentDoc').textContent = 'Связать / сменить Google Doc';
    setStatus('Связанный Google Doc сохранён. Перед дописыванием Архиватор проверит точку продолжения.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('saveCurrentDocLink').disabled = false;
  }
};

$('clearCurrentDocLink').onclick = async () => {
  const archive = state?.archive;
  if (!archive?.id || !archive.sourceUrl) return;
  $('clearCurrentDocLink').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CLEAR_LINKED_DOC',
      archiveId: archive.id,
      sourceUrl: archive.sourceUrl
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось отвязать Google Doc.');
    await getState();
    $('currentDocEditor').classList.add('hidden');
    $('editCurrentDoc').textContent = 'Связать / сменить Google Doc';
    setStatus('Связь с Google Doc удалена. Сам документ не изменён.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('clearCurrentDocLink').disabled = false;
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

$('deleteArchive').onclick = async () => {
  const archive = state?.archive;
  if (!archive) return;
  if (!confirm('Удалить только локальный архив? Связанный документ Google Docs останется без изменений.')) return;

  $('deleteArchive').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_DELETE_ARCHIVE',
      archiveId: archive.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось удалить локальный архив.');
    await getState();
    setStatus('Локальный архив удалён. Связанный документ Google Docs, если он был, не изменён.');
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('deleteArchive').disabled = false;
  }
};

$('deleteArchiveAndDoc').onclick = async () => {
  const archive = state?.archive;
  const docUrl = state?.archiveDestination?.kind === 'google-doc'
    ? (state.archiveDestination.url || '')
    : (state?.linkedDoc?.url || '');
  if (!archive?.id || !docUrl) return;
  if (!confirm(
    'Удалить локальный архив и переместить связанный Google Doc в корзину? ' +
    'Это затронет весь документ Google Docs, а не только этот снимок архива.'
  )) return;

  $('deleteArchiveAndDoc').disabled = true;
  $('deleteArchive').disabled = true;
  setStatus('Перемещаю Google Doc в корзину и удаляю локальный архив…', false, true);
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_DELETE_ARCHIVE_WITH_DOC',
      archiveId: archive.id
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось удалить архив вместе с Google Doc.');
    await getState();
    setStatus('Локальный архив удалён. Google Doc перемещён в корзину.');
  } catch (error) {
    setStatus(error.message || String(error), true);
    await getState().catch(() => {});
  } finally {
    $('deleteArchiveAndDoc').disabled = false;
    $('deleteArchive').disabled = false;
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
  setStatus('Открываю документ Google Docs и вставляю переписку…', false, true);
  try {
    const result = await exportToDoc('ARCHIVER_EXPORT_NEW_DOC', { archiveId: state?.archive?.id || '' });
    const imageInline = Number(result.imageInlinePasteCount || 0);
    const imageInserted = Number(result.imageInsertedCount || 0);
    const imageFailed = Number(result.imageFailedCount || 0);
    const imageAdded = imageInserted || imageInline;
    const imagePart = (imageAdded || imageFailed)
      ? ' Картинки: добавлено ' + imageAdded +
        (imageFailed ? ', не удалось ' + imageFailed : '') + '.'
      : '';
    setStatus(`Готово. В новый документ Google Docs вставлено ${result.addedCount || 0} сообщений.` + imagePart);
    await getState();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    $('newDoc').disabled = false;
  }
};

$('activeDoc').onclick = async () => {
  $('activeDoc').disabled = true;
  const linked = Boolean(state?.linkedDoc?.url);
  setStatus(
    linked
      ? 'Открываю связанный документ Google Docs и проверяю, что уже вставлено…'
      : 'Проверяю, что уже вставлено в открытый документ Google Docs…',
    false,
    true
  );
  try {
    const result = await exportToDoc(
      linked ? 'ARCHIVER_EXPORT_LINKED_DOC' : 'ARCHIVER_EXPORT_ACTIVE_DOC',
      { archiveId: state?.archive?.id || '' }
    );
    const imageInline = Number(result.imageInlinePasteCount || 0);
    const imageInserted = Number(result.imageInsertedCount || 0);
    const imageFailed = Number(result.imageFailedCount || 0);
    const imageAttempted = Number(result.recoveredImagePatchCandidateCount || 0);
    const failureReason = String(result.firstImageFailure || '').trim();
    const imageAdded = imageInserted || imageInline;
    const imagePart = (imageAdded || imageFailed || imageAttempted)
      ? ' Картинки: добавлено ' + imageAdded +
        (imageFailed ? ', не удалось ' + imageFailed : '') +
        (failureReason ? '. Причина: ' + failureReason : '') + '.'
      : '';

    if (result.noChanges) {
      setStatus(
        linked
          ? 'Связанный документ Google Docs открыт. Новых сообщений и невставленных сохранённых изображений нет.'
          : 'В этом документе Google Docs уже есть все сообщения из локального архива.'
      );
    } else if (result.addedCount) {
      setStatus(
        `Готово. В конец документа добавлено ${result.addedCount || 0} новых сообщений.` +
        imagePart
      );
    } else if (imageInline || imageInserted || imageFailed || imageAttempted) {
      setStatus(
        'Текст повторно не вставлялся.' + imagePart,
        Boolean(imageFailed && !imageInserted)
      );
    } else {
      setStatus('Связанный документ Google Docs открыт и проверен.');
    }
    await getState();
    await showWhatsNewIfNeeded();
  } catch (error) {
    setStatus(error.message || String(error), true);
    await getState().catch(() => {});
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

const TOUR_STORAGE_KEY = 'archiverIntroSeen';
const WHATS_NEW_PENDING_KEY = 'archiverWhatsNewPending';
const TOUR_STEPS = [
  {
    selector: '#captureTarget',
    title: 'Выберите, где собирать',
    text: 'Фоновый режим собирает чат в отдельной рабочей вкладке и оставляет исходный диалог свободным. Текущая вкладка — резервный вариант.'
  },
  {
    selector: '#capture',
    title: 'Запустите сбор',
    text: 'Нажмите «Собрать чат». Архиватор зафиксирует конец переписки, дойдёт до начала и соберёт сообщения в хронологическом порядке.'
  },
  {
    selector: '',
    title: 'Оборванный проход не пропадает',
    text: 'Если сбор прервётся после сохранения части сообщений, появится один незавершённый сбор. Его можно продолжить или сохранить текущую часть в Google Docs.'
  },
  {
    selector: '#savedArchivesPanel .section-bar',
    title: 'Готовые чаты — в одном списке',
    text: 'Здесь можно продолжить чат, скопировать его, сохранить в документ Google Docs или разбить по темам.'
  },
  {
    selector: '.settings-menu > summary',
    title: 'Настройки в одном месте',
    text: 'Шестерёнка открывает оформление интерфейса, подписи в документе и обновление расширения.'
  },
  {
    selector: '.help-menu > summary',
    title: 'Справка всегда рядом',
    text: 'Знак вопроса открывает справку: здесь можно снова запустить знакомство, открыть полную инструкцию и скопировать контакт разработчика.'
  }
];
let tourIndex = 0;
let tourOpenedDetails = null;

function closeTourOpenedDetails() {
  if (tourOpenedDetails) {
    tourOpenedDetails.open = false;
    tourOpenedDetails = null;
  }
}

function clearTourTarget() {
  document.querySelectorAll('.tour-target').forEach(node => node.classList.remove('tour-target'));
  const spotlight = $('tourSpotlight');
  if (spotlight) spotlight.classList.add('hidden');
}

function positionTour(target) {
  const overlay = $('tourOverlay');
  const card = document.querySelector('.tour-card');
  if (!overlay || !card) return;

  const margin = 12;
  const interfaceWidth = 430;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const availableRail = Math.max(240, vw - interfaceWidth - margin * 2);
  const cardWidth = Math.min(280, availableRail);

  card.style.width = cardWidth + 'px';
  card.style.left = Math.max(interfaceWidth + margin, vw - cardWidth - margin) + 'px';

  const cr = card.getBoundingClientRect();
  const preferredTop = target ? target.getBoundingClientRect().top : Math.round((vh - cr.height) / 2);
  const top = Math.max(margin, Math.min(vh - cr.height - margin, preferredTop));
  card.style.top = top + 'px';
}

function renderTourStep() {
  const overlay = $('tourOverlay');
  const step = TOUR_STEPS[tourIndex];
  if (!overlay || !step) return;

  clearTourTarget();
  closeTourOpenedDetails();

  if (step.openDetails) {
    const details = document.querySelector(step.openDetails);
    if (details) {
      details.open = true;
      tourOpenedDetails = details;
    }
  }

  const target = step.selector ? document.querySelector(step.selector) : null;
  if (target && !target.classList.contains('hidden')) {
    target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    target.classList.add('tour-target');
  }

  $('tourStep').textContent = (tourIndex + 1) + ' из ' + TOUR_STEPS.length;
  $('tourTitle').textContent = step.title;
  $('tourText').textContent = step.text;
  $('tourPrev').disabled = tourIndex === 0;
  $('tourNext').textContent = tourIndex === TOUR_STEPS.length - 1 ? 'Готово' : 'Далее';

  requestAnimationFrame(() => positionTour(target && !target.classList.contains('hidden') ? target : null));
}

async function openTour() {
  tourIndex = 0;
  document.querySelectorAll('.header-menu[open]').forEach(details => {
    details.open = false;
  });
  document.body.classList.add('tour-open');
  $('tourOverlay').classList.remove('hidden');
  $('tourOverlay').setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => renderTourStep());
}

async function closeTour(markSeen = true) {
  clearTourTarget();
  closeTourOpenedDetails();
  $('tourOverlay').classList.add('hidden');
  $('tourOverlay').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('tour-open');
  if (markSeen) await chrome.storage.local.set({ [TOUR_STORAGE_KEY]: true });
}

const WHATS_NEW_COPY = {
  '0.4.26': [
    'Продолжение теперь фиксирует настоящий конец чата, а не текущую видимую область.',
    'Повторяющиеся одинаковые реплики больше не теряются при продолжении и recovery.',
    'Стык подтверждается по стабильному ID или соседнему хвосту и повторно проверяется перед слиянием.',
    'Повторный recovery больше не может дописать новый префикс после старого и перепутать порядок сообщений.'
  ],
  '0.4.25': [
    'В сохранённых чатах снова доступны прямые действия «Продолжить» и Google Docs.',
    'Картинки больше не теряются из-за частично неудачной подготовки: старый rich-HTML путь работает как резервный для отдельных изображений.',
    'Одинаковые технические черновики схлопываются, а сверка корректно считает повторяющиеся одинаковые реплики.',
    'Появилось отдельное действие удаления локального архива вместе с перемещением связанного Google Doc в корзину.'
  ],
  '0.3.49': [
    'Знакомство теперь открывается отдельной боковой карточкой и не перекрывает основной интерфейс.',
    'При запуске знакомства раскрытая справка или настройки сначала сворачиваются и больше не открываются поверх шагов.',
    'Во время знакомства нет затемняющей подложки вокруг интерфейса.'
  ],
  '0.3.48': [
    'Незавершённый сбор теперь сохраняется по ходу хронологического прохода, поэтому закрытие рабочей вкладки не должно терять точку продолжения.',
    'Знакомство автоматически сворачивает открытую справку или настройки перед первым шагом.',
    'Индикатор доступного обновления в popup теперь всегда зелёный.'
  ],
  '0.3.47': [
    'После оборванного сбора Архиватор предлагает продолжить сохранённый проход, а не начинать заново.',
    'Знакомство больше не размывает интерфейс и подсвечивает сам элемент управления.'
  ],
  '0.3.46': [
    'Незавершённый сбор можно продолжить прямо из списка.',
    'В «Сохранённых архивах» видно, перенесён ли чат в документ. Можно отметить это вручную и добавить любую ссылку.',
    'Знакомство точнее подсвечивает элементы интерфейса.'
  ]
};

async function showWhatsNewIfNeeded() {
  const result = await chrome.storage.local.get(WHATS_NEW_PENDING_KEY);
  const pending = result[WHATS_NEW_PENDING_KEY];
  if (!pending?.version) return;

  const items = WHATS_NEW_COPY[pending.version] || ['Расширение обновлено. Изменения перечислены в журнале версии.'];
  $('whatsNewTitle').textContent = 'Новое в ' + pending.version;
  const list = $('whatsNewList');
  list.textContent = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
  $('whatsNew').classList.remove('hidden');
}

$('dismissWhatsNew').onclick = async () => {
  $('whatsNew').classList.add('hidden');
  await chrome.storage.local.remove(WHATS_NEW_PENDING_KEY);
};

$('showTour').onclick = () => openTour();
$('tourSkip').onclick = () => closeTour(true);
$('tourPrev').onclick = () => {
  if (tourIndex > 0) {
    tourIndex--;
    renderTourStep();
  }
};
$('tourNext').onclick = () => {
  if (tourIndex >= TOUR_STEPS.length - 1) {
    closeTour(true);
    return;
  }
  tourIndex++;
  renderTourStep();
};

$('copyContact').onclick = async () => {
  const email = 'nekurismarieykjuri@gmail.com';
  try {
    await navigator.clipboard.writeText(email);
    $('contactCopied').textContent = 'Почта скопирована';
    setTimeout(() => { $('contactCopied').textContent = ''; }, 1200);
  } catch (_) {
    setStatus('Не удалось скопировать почту. Адрес: ' + email, true);
  }
};

async function refreshUpdateNotice() {
  const notice = $('updateNotice');
  if (!notice) return;
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_CHECK_UPDATE' }).catch(() => null);
  const available = Boolean(result?.ok && result.available);
  const failed = !result?.ok;
  notice.classList.toggle('hidden', !available && !failed);
  if (available) {
    $('updateNoticeText').textContent = 'Доступно обновление ' + result.remoteVersion;
    $('updateNoticeAction').textContent = 'Обновить';
  } else if (failed) {
    $('updateNoticeText').textContent = 'Не удалось проверить обновление: ' + (result?.error || 'нет ответа от фонового процесса');
    $('updateNoticeAction').textContent = 'Проверить вручную';
  }
}

$('consolidateSavedArchives').addEventListener('click', async () => {
  const button = $('consolidateSavedArchives');
  button.disabled = true;
  setStatus('Сверяю реальные стыки сохранённых архивов…', false, true);
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CONSOLIDATE_SAVED_ARCHIVES'
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сверить архивы.');
    if (result.mergedCount) {
      setStatus('Подтверждённо объединено групп архивов: ' + result.mergedCount +
        '. Исходные файлы сохранены без удаления.');
    } else {
      setStatus('Доказанного хронологического перекрытия не найдено. Архивы оставлены раздельно.');
    }
    await loadFastArchiveLibrary();
    await hydrateSavedArchiveDetails();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
});

$('localVersion').textContent = chrome.runtime.getManifest().version || '—';

$('reloadExtension').addEventListener('click', () => {
  setStatus('Перезагружаю расширение…');
  setTimeout(() => chrome.runtime.reload(), 120);
});

(async () => {
  void loadFastArchiveLibrary().catch(error => setStatus(error.message || String(error), true));
  try {
    const settings = await loadSettings();
    $('userName').value = settings.userName;
    $('assistantName').value = settings.assistantName;
    $('alignUserRight').checked = settings.alignUserRight;
    $('captureTarget').value = settings.captureTarget === 'current' ? 'current' : 'copy';
    updateCaptureTargetHint($('captureTarget').value);
    renderInterfaceAppearanceControls(settings);
    applyInterfaceAppearance(settings);
    void refreshBoundaryMarkingControl().catch(() => {});

    // Active capture state is tiny and must win the startup race. Load it before
    // the archive library, update check, tour metadata, or any other heavy UI data.
    const live = await getLiveState().catch(() => null);
    if (live?.job && ['starting', 'running', 'paused'].includes(live.job.status)) {
      startPolling();
    }

    const result = await getState();
    void hydrateSavedArchiveDetails().catch(error => setStatus(error.message || String(error), true));
    if (result?.linkedDoc?.url && !$('docUrl').value) $('docUrl').value = result.linkedDoc.url;
    if (result?.job && ['starting', 'running', 'paused'].includes(result.job.status)) startPolling();

    void refreshUpdateNotice().catch(() => {});
    void showWhatsNewIfNeeded().catch(() => {});

    const introState = await chrome.storage.local.get(TOUR_STORAGE_KEY);
    if (!introState[TOUR_STORAGE_KEY]) {
      setTimeout(() => openTour(), 180);
    }
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
})();
