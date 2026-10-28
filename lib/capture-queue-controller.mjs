import {
  QUEUE_MODES, queueLanePlan, chooseRunnableQueueItems,
  joinVerifiedSplitCapture, queueResumePlan
} from './capture-queue.mjs';
import { conversationKey } from './urls.mjs';

const STORAGE_KEY = 'archiverCaptureQueueV1';
const VERSION_KEY = 'archiverCaptureQueueRuntimeVersion';
const JOB_PREFIX = 'archiverQueueJob:';
const RUNNING = new Set(['starting', 'running', 'paused', 'stopping']);
const TERMINAL = new Set(['done', 'error', 'cancelled']);

export function createCaptureQueueController(chrome, deps) {
  let gate = Promise.resolve();
  let pumpActive = false;
  let publishGate = Promise.resolve();

  const serialized = action => {
    const result = gate.then(action);
    gate = result.then(() => {}, () => {});
    return result;
  };
  const publishing = action => {
    const result = publishGate.then(action);
    publishGate = result.then(() => {}, () => {});
    return result;
  };
  const empty = () => ({ enabled: false, items: [], workers: [] });
  const read = async () => {
    const value = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    return value && Array.isArray(value.items) && Array.isArray(value.workers)
      ? value : empty();
  };
  const save = async state => chrome.storage.local.set({ [STORAGE_KEY]: state });
  const workerKey = id => JOB_PREFIX + id;
  const findWorker = (state, id) => state.workers.find(worker => worker.jobId === id);
  const findItem = (state, id) => state.items.find(item => item.id === id);
  const publicState = state => ({
    enabled: state.enabled,
    items: state.items.map(item => ({ ...item })),
    workers: state.workers.map(worker => ({
      jobId: worker.jobId, itemId: worker.itemId, lane: worker.lane,
      sourceUrl: worker.sourceUrl,
      status: worker.status, phase: worker.phase, count: worker.count,
      message: worker.message, captureTabId: worker.captureTabId,
      draftId: worker.draftId || '', archiveId: worker.archiveId || '',
      physicalStepCount: worker.physicalStepCount ?? null,
      physicalScrollTop: worker.physicalScrollTop ?? null,
      updatedAt: worker.updatedAt
    }))
  });
  const makeId = prefix => prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const markerKey = url => {
    const source = new URL(url);
    return 'archiverFragmentMarkers:' + source.origin + source.pathname;
  };
  const loadMarkers = async url => {
    const key = markerKey(url);
    return (await chrome.storage.local.get(key))[key] || {};
  };
  const checkUrl = url => {
    const value = String(url || '').trim();
    if (!deps.isConversationUrl(value) || !conversationKey(value)) {
      throw new Error('Нужна ссылка на конкретную переписку ChatGPT.');
    }
    return value;
  };
  const syncWorker = async worker => {
    await chrome.storage.local.set({ [workerKey(worker.jobId)]: worker });
  };
  const mutateWorker = (jobId, edit) => serialized(async () => {
    const state = await read();
    const worker = findWorker(state, jobId);
    if (!worker) return null;
    const result = await edit(worker, state);
    worker.updatedAt = Date.now();
    await chrome.storage.local.set({
      [STORAGE_KEY]: state,
      [workerKey(jobId)]: worker
    });
    return result ?? worker;
  });
  const updateItemStatus = (item, workers) => {
    const lanes = workers.filter(w => w.itemId === item.id);
    if (!lanes.length) return;
    if (lanes.some(w => w.status === 'error')) {
      item.status = 'error';
    } else if (lanes.some(w => w.status === 'cancelled')) {
      item.status = 'cancelled';
    } else if (lanes.every(w => w.status === 'done') &&
        lanes.length === (item.mode === QUEUE_MODES.SPLIT_CHAT ? 2 : 1)) {
      item.status = item.mode === QUEUE_MODES.SPLIT_CHAT ? 'awaiting-merge' : 'done';
    } else if (lanes.some(w => RUNNING.has(w.status))) {
      item.status = 'running';
    }
  };

  async function enqueue({ sourceUrl, mode = QUEUE_MODES.TWO_CHATS } = {}) {
    const url = checkUrl(sourceUrl);
    if (![QUEUE_MODES.TWO_CHATS, QUEUE_MODES.SPLIT_CHAT].includes(mode)) {
      throw new Error('Неизвестный режим очереди.');
    }
    const result = await serialized(async () => {
      const state = await read();
      const duplicate = state.items.find(item =>
        conversationKey(item.sourceUrl) === conversationKey(url) &&
        !TERMINAL.has(item.status)
      );
      if (duplicate) throw new Error('Этот чат уже находится в очереди или собирается.');
      const item = {
        id: makeId('queue-'), sourceUrl: url, mode, status: 'queued',
        createdAt: Date.now(), captureRange: null, error: '',
        archiveId: '', attempts: 0
      };
      state.items.push(item);
      await save(state);
      return { ok: true, item };
    });
    void pump().catch(() => {});
    return result;
  }

  async function change(id, { mode } = {}) {
    if (![QUEUE_MODES.TWO_CHATS, QUEUE_MODES.SPLIT_CHAT].includes(mode)) {
      throw new Error('Неизвестный режим очереди.');
    }
    const result = await serialized(async () => {
      const state = await read();
      const item = findItem(state, id);
      if (!item) throw new Error('Задание очереди не найдено.');
      if (item.status !== 'queued') throw new Error('Режим можно менять только до запуска.');
      item.mode = mode;
      item.captureRange = null;
      item.error = '';
      await save(state);
      return { ok: true, item };
    });
    void pump().catch(() => {});
    return result;
  }

  async function remove(id) {
    return serialized(async () => {
      const state = await read();
      const item = findItem(state, id);
      if (!item) return { ok: true, removed: false };
      const active = state.workers.some(worker => worker.itemId === id && RUNNING.has(worker.status));
      if (active) throw new Error('Сначала остановите оба прохода этого задания.');
      state.items = state.items.filter(row => row.id !== id);
      state.workers = state.workers.filter(row => row.itemId !== id);
      await save(state);
      // Archives/drafts from previous attempts are intentionally not deleted.
      return { ok: true, removed: true };
    });
  }

  async function retry(id) {
    const result = await serialized(async () => {
      const state = await read();
      const item = findItem(state, id);
      if (!item || !TERMINAL.has(item.status)) throw new Error('Задание не готово к повтору.');
      const previous = state.workers.filter(worker => worker.itemId === id);
      if (previous.some(worker => RUNNING.has(worker.status))) {
        throw new Error('Одна из вкладок ещё выполняет прежний проход.');
      }

      // If one lane is complete and the other failed, reuse the verified
      // complete archive rather than re-scanning that half of the conversation.
      const retainDone = item.mode === QUEUE_MODES.SPLIT_CHAT &&
        previous.some(worker => worker.status === 'done') &&
        previous.some(worker => worker.status !== 'done');
      const retained = retainDone ? previous.filter(worker => worker.status === 'done') : [];
      item.resumeCandidates = {};
      for (const worker of previous) {
        if (retained.includes(worker) || worker.status === 'done') continue;
        const draftId = worker.draftId || worker.recoveryDraftId || '';
        if (draftId) item.resumeCandidates[worker.lane] = draftId;
      }
      item.previousAttempts = [
        ...(item.previousAttempts || []),
        ...previous.map(worker => ({
          jobId: worker.jobId, lane: worker.lane, status: worker.status,
          draftId: worker.draftId || '', archiveId: worker.archiveId || ''
        }))
      ].slice(-30);
      state.workers = state.workers.filter(worker => worker.itemId !== id || retained.includes(worker));
      item.status = 'queued';
      item.archiveId = '';
      item.error = '';
      // Do not change the original immutable range on retry. Re-reading
      // mutable current markers could silently change the archive's scope.
      await save(state);
      return { ok: true };
    });
    void pump().catch(() => {});
    return result;
  }

  async function enable(value = true) {
    await serialized(async () => {
      const state = await read();
      state.enabled = Boolean(value);
      await save(state);
    });
    if (value) void pump().catch(() => {});
    return { ok: true, queue: publicState(await read()) };
  }

  async function cancel(id) {
    const active = await serialized(async () => {
      const state = await read();
      const item = findItem(state, id);
      if (!item) throw new Error('Задание не найдено.');
      const running = state.workers.filter(worker => worker.itemId === id && RUNNING.has(worker.status));
      if (!running.length) {
        item.status = 'cancelled';
      } else {
        for (const worker of running) worker.status = 'stopping';
        item.status = 'stopping';
      }
      await save(state);
      return running;
    });
    for (const worker of active) {
      if (worker.captureTabId == null) continue;
      await chrome.tabs.sendMessage(worker.captureTabId, {
        type: 'ARCHIVER_CANCEL_CAPTURE', jobId: worker.jobId
      }).catch(() => {});
    }
    return { ok: true };
  }

  async function reserve() {
    return serialized(async () => {
      const state = await read();
      if (!state.enabled || await deps.legacyCaptureActive()) return { tasks: [], retry: false };
      const rows = chooseRunnableQueueItems(state.items, state.workers);
      const tasks = [];
      let retry = false;
      for (const item of rows) {
        try {
          const markers = item.mode === QUEUE_MODES.SPLIT_CHAT
            ? (item.captureRange || await loadMarkers(item.sourceUrl)) : null;
          const proposed = { ...item, captureRange: markers };
          const plans = queueLanePlan(proposed);
          item.captureRange = markers;
          item.status = 'starting';
          item.error = '';
          item.attempts++;
          const completed = new Set(state.workers.filter(worker =>
            worker.itemId === item.id && worker.status === 'done'
          ).map(worker => worker.lane));
          for (const plan of plans.filter(plan => !completed.has(plan.lane))) {
            const oldId = item.resumeCandidates?.[plan.lane] || '';
            const oldDraft = oldId
              ? (await chrome.storage.local.get('draft:' + oldId))['draft:' + oldId]
              : null;
            const resume = oldDraft
              ? queueResumePlan(oldDraft, item.sourceUrl, plan)
              : null;
            const worker = {
              jobId: makeId('queue-worker-'), itemId: item.id, lane: plan.lane,
              sourceUrl: item.sourceUrl, captureMode: plan.mode,
              captureRange: plan.captureRange, captureTarget: 'copy',
              status: 'starting', phase: 'top', count: 0, updatedAt: Date.now(),
              startedAt: Date.now(), captureTabId: null, draftId: '',
              recoveryDraftId: resume?.existingDraftId || '',
              resumeOptions: resume || null,
              message: resume
                ? 'Восстанавливаю собственный сохранённый проход…'
                : oldId
                  ? 'Предыдущий черновик оставлен: его границы нельзя доказать. Запускаю новый проход.'
                  : 'Открываю отдельную рабочую вкладку…'
            };
            state.workers.push(worker);
            tasks.push(worker);
          }
        } catch (error) {
          item.status = 'error';
          item.error = error?.message || String(error);
          retry = true;
        }
      }
      await save(state);
      for (const worker of tasks) await syncWorker(worker);
      return { tasks, retry };
    });
  }

  async function launchWorker(worker) {
    let tab = null;
    let original = null;
    try {
      [original] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = await chrome.tabs.create({ url: worker.sourceUrl, active: true });
      await chrome.tabs.update(tab.id, { active: true, autoDiscardable: false }).catch(() => {});
      await deps.waitForChatTabComplete(tab.id);
      await deps.waitForChatDomReady(tab.id, 45000);
      await mutateWorker(worker.jobId, w => {
        w.captureTabId = tab.id;
        w.message = 'Рабочая вкладка готова; запускаю проход…';
      });
      await deps.ensureChatGptContentScript(tab.id, worker.jobId, {
        ...(worker.resumeOptions || {}),
        mode: worker.resumeOptions?.mode || worker.captureMode,
        captureRange: worker.captureRange,
        queueCapture: true,
        seekMarkedStart: worker.captureMode === 'fragment' && !worker.resumeOptions
      });
      await mutateWorker(worker.jobId, (w, state) => {
        if (w.status === 'starting') w.status = 'running';
        w.message = 'Проход запущен.';
        const item = findItem(state, w.itemId);
        if (item && item.status === 'starting') item.status = 'running';
      });
    } catch (error) {
      await markFailed(worker.jobId, error?.message || String(error));
      if (tab?.id) {
        const health = await chrome.tabs.sendMessage(tab.id, {
          type: 'ARCHIVER_CAPTURE_HEALTH', jobId: worker.jobId
        }).catch(() => null);
        if (!health?.running) await chrome.tabs.remove(tab.id).catch(() => {});
      }
    } finally {
      if (original?.id) await chrome.tabs.update(original.id, { active: true }).catch(() => {});
      if (original?.windowId != null) {
        await chrome.windows.update(original.windowId, { focused: true }).catch(() => {});
      }
    }
  }

  async function pump() {
    if (pumpActive) return;
    pumpActive = true;
    try {
      for (let cycle = 0; cycle < 40; cycle++) {
        const { tasks, retry: hadInvalid } = await reserve();
        for (const worker of tasks) await launchWorker(worker);
        if (!tasks.length && !hadInvalid) break;
      }
    } finally {
      pumpActive = false;
    }
  }

  async function progress(message, tabId) {
    const id = String(message.jobId || '');
    const patch = message.patch || {};
    const next = await mutateWorker(id, (worker, state) => {
      if (worker.captureTabId !== tabId || !['starting', 'running'].includes(worker.status)) {
        throw new Error('Прогресс не принадлежит активному проходу очереди.');
      }
      const allowed = [
        'phase', 'count', 'message', 'captureBoundary', 'draftCount',
        'imageCount', 'imageBinaryReady', 'imageBinaryFailed',
        'physicalStepCount', 'physicalScrollTop', 'physicalScrollHeight',
        'physicalScrollDelta', 'rawCollectedCount', 'trimmedBeforeMarkedStart',
        'trimmedAfterMarkedEnd', 'boundaryReached'
      ];
      for (const field of allowed) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) worker[field] = patch[field];
      }
      worker.status = 'running';
      const item = findItem(state, worker.itemId);
      if (item && item.status === 'starting') item.status = 'running';
    });
    return next ? { ok: true } : { ok: false, error: 'Задание очереди отсутствует.' };
  }

  async function checkpoint(message, tabId) {
    const id = String(message.jobId || '');
    const draftId = String(message.draftId || '');
    const state = await read();
    const worker = findWorker(state, id);
    if (!worker || worker.captureTabId !== tabId || !RUNNING.has(worker.status) ||
        !draftId || (draftId !== worker.draftId && draftId !== 'draft-' + id)) {
      return { ok: false, error: 'Контрольная точка не принадлежит этому проходу.' };
    }
    if (!await chrome.storage.local.getBytesInUse('draft:' + draftId)) {
      return { ok: false, error: 'Контрольная точка не сохранилась.' };
    }
    await mutateWorker(id, w => {
      w.draftId = draftId;
      w.draftCount = Math.max(Number(w.draftCount || 0), Number(message.draftCount || 0));
    });
    return { ok: true };
  }

  async function authorized(jobId, tabId) {
    const state = await read();
    const worker = findWorker(state, jobId);
    return worker && worker.captureTabId === tabId && RUNNING.has(worker.status)
      ? worker : null;
  }

  async function preserveLanes(item, workers) {
    const drafts = [];
    for (const worker of workers) {
      if (!worker.archiveId) continue;
      const archive = await deps.getArchive(worker.archiveId);
      if (!archive?.messages?.length) continue;
      const id = 'queue-split:' + item.id + ':' + worker.lane;
      const draft = {
        id, kind: 'capture-draft', title: archive.title || 'Переписка ChatGPT',
        sourceUrl: archive.sourceUrl, capturedAt: archive.capturedAt,
        captureMode: 'fragment', capturePhase: 'finalizing',
        captureBoundary: {
          kind: 'stable', key: worker.captureRange.end.id
        },
        captureRange: worker.captureRange, complete: false,
        partial: true, messages: archive.messages,
        imageCount: archive.imageCount || 0,
        imageBinaryReady: archive.imageBinaryReady || 0,
        imageBinaryFailed: archive.imageBinaryFailed || 0,
        chronologicalCount: archive.messages.length,
        error: item.error || 'Не удалось доказать полный стык двух потоков.'
      };
      await chrome.storage.local.set({ ['draft:' + id]: draft });
      drafts.push(id);
    }
    return drafts;
  }

  async function finalizeSplit(itemId) {
    let selected = null;
    await serialized(async () => {
      const state = await read();
      const item = findItem(state, itemId);
      if (!item || item.mode !== QUEUE_MODES.SPLIT_CHAT) return;
      const lanes = state.workers.filter(worker => worker.itemId === itemId);
      if (lanes.length !== 2 || lanes.some(worker => !TERMINAL.has(worker.status))) return;
      if (item.status === 'done' || item.status === 'finalizing' || item.finalizationStarted) return;
      item.finalizationStarted = true;
      item.status = 'finalizing';
      selected = { item: { ...item }, workers: lanes.map(worker => ({ ...worker })) };
      await save(state);
    });
    if (!selected) return;
    let output = null;
    let error = '';
    try {
      const { item, workers } = selected;
      if (!workers.every(worker => worker.status === 'done')) {
        throw new Error('Один из проходов не завершился; обе части сохранены независимо.');
      }
      const first = workers.find(worker => worker.lane === 'first');
      const second = workers.find(worker => worker.lane === 'second');
      if (!first || !second) throw new Error('Не найдены обе части.');
      const a = await deps.getArchive(first.archiveId);
      const b = await deps.getArchive(second.archiveId);
      const merged = joinVerifiedSplitCapture(item, a, b, deps.mergeMessage);
      const images = merged.messages.flatMap(message => message.images || []);
      output = {
        ...a,
        id: 'queue-merged:' + item.id,
        sourceUrl: item.sourceUrl,
        capturedAt: new Date().toISOString(),
        complete: true, partial: false, isFragment: false,
        lastCaptureMode: 'experimental-two-streams',
        manualRangeMarkers: item.captureRange,
        messages: merged.messages,
        imageCount: images.length,
        imageBinaryReady: images.filter(image => image.binaryStatus === 'ready' && image.dataUrl).length,
        imageBinaryFailed: images.filter(image => image.binaryStatus === 'failed').length,
        captureProof: {
          mode: 'experimental-two-streams', startVerified: true,
          endVerified: true, overlapVerified: true,
          overlapCount: merged.overlap, sources: merged.sourceIds
        },
        queueSourceArchives: merged.sourceIds
      };
      await publishing(() => deps.publishArchive(output));
    } catch (e) {
      error = e?.message || String(e);
      selected.item.error = error;
      await preserveLanes(selected.item, selected.workers);
    }
    await serialized(async () => {
      const state = await read();
      const item = findItem(state, itemId);
      if (!item) return;
      item.status = output && !error ? 'done' : 'error';
      item.archiveId = output && !error ? output.id : '';
      item.error = error;
      item.finalizationStarted = false;
      await save(state);
    });
    void pump().catch(() => {});
  }

  async function complete(message, tabId) {
    const jobId = String(message.jobId || '');
    const worker = await authorized(jobId, tabId);
    if (!worker) return { ok: false, status: 'error', error: 'Чужой или завершённый проход.' };
    if (worker.status === 'stopping') {
      await markFailed(jobId, 'Сбор остановлен пользователем.', worker.draftId || '', true);
      return { ok: false, status: 'cancelled', error: 'Сбор остановлен пользователем.' };
    }
    const archive = await deps.getArchive(message.archiveId || '');
    if (!archive || !archive.id?.endsWith('-q-' + jobId) ||
        conversationKey(archive.sourceUrl || '') !== conversationKey(worker.sourceUrl) ||
        archive.captureProof?.mode !== worker.captureMode ||
        !archive.captureProof?.startVerified || !archive.captureProof?.endVerified ||
        !archive.captureBoundaryReached) {
      await markFailed(jobId, 'Не подтверждены оба края собранного диапазона; архив сохранён для восстановления.');
      return { ok: false, status: 'error', error: 'Не подтверждена полнота архива.' };
    }
    try {
      if (worker.captureMode === 'full') {
        await publishing(() => deps.publishArchive({ ...archive, partial: false, complete: true }));
      }
      await mutateWorker(jobId, (current, state) => {
        current.status = 'done';
        current.phase = 'done';
        current.archiveId = archive.id;
        current.count = archive.messages.length;
        current.message = 'Проход завершён; архив проверен.';
        const item = findItem(state, current.itemId);
        if (item) {
          if (item.mode === QUEUE_MODES.TWO_CHATS) item.archiveId = archive.id;
          updateItemStatus(item, state.workers);
        }
      });
      if (worker.captureMode === 'fragment') await finalizeSplit(worker.itemId);
      void pump().catch(() => {});
      return { ok: true, status: 'done', archiveId: archive.id };
    } catch (error) {
      await markFailed(jobId, error?.message || String(error));
      return { ok: false, status: 'error', error: error?.message || String(error) };
    }
  }

  async function markFailed(jobId, message, draftId = '', cancelled = false) {
    const worker = await mutateWorker(jobId, (current, state) => {
      if (TERMINAL.has(current.status)) return;
      current.status = cancelled ? 'cancelled' : 'error';
      current.phase = 'error';
      current.message = message;
      current.error = message;
      current.draftId = draftId || current.draftId || '';
      const item = findItem(state, current.itemId);
      if (item) {
        item.error = message;
        updateItemStatus(item, state.workers);
      }
    });
    if (worker) {
      await finalizeSplit(worker.itemId);
      void pump().catch(() => {});
    }
    return { ok: true };
  }

  async function failed(message, tabId) {
    const worker = await authorized(String(message.jobId || ''), tabId);
    if (!worker) return { ok: true, ignored: true };
    return markFailed(worker.jobId, message.error || 'Сбор прерван.',
      String(message.draftId || ''), message.status === 'cancelled');
  }

  async function tabClosed(tabId) {
    const state = await read();
    const jobs = state.workers.filter(worker => worker.captureTabId === tabId && RUNNING.has(worker.status));
    for (const job of jobs) {
      await markFailed(job.jobId, 'Рабочая вкладка была закрыта. Черновики не удалены.');
    }
  }

  async function tabNavigated(tabId, currentUrl = '') {
    const actual = conversationKey(currentUrl || '');
    if (!actual) return;
    const state = await read();
    const affected = state.workers.filter(worker =>
      worker.captureTabId === tabId && RUNNING.has(worker.status) &&
      actual !== conversationKey(worker.sourceUrl)
    );
    for (const worker of affected) {
      await markFailed(
        worker.jobId,
        'Рабочая вкладка переключилась на другой чат; результаты не публикуются.'
      );
      await chrome.tabs.sendMessage(tabId, {
        type: 'ARCHIVER_CANCEL_CAPTURE', jobId: worker.jobId
      }).catch(() => {});
    }
  }

  async function tick() {
    const state = await read();
    for (const worker of state.workers.filter(worker => RUNNING.has(worker.status))) {
      if (Date.now() - Number(worker.updatedAt || worker.startedAt || 0) < 300000) continue;
      const alive = await Promise.race([
        chrome.tabs.sendMessage(worker.captureTabId, {
          type: 'ARCHIVER_CAPTURE_HEALTH', jobId: worker.jobId
        }).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 1800))
      ]);
      if (alive?.running && alive.jobId === worker.jobId) {
        await mutateWorker(worker.jobId, w => { w.message = w.message || 'Сбор выполняется.'; });
      } else {
        await markFailed(worker.jobId, 'Проход перестал отвечать; прежний черновик сохранён.');
      }
    }
    void pump().catch(() => {});
    return publicState(await read());
  }

  async function versionCheck(version) {
    await serialized(async () => {
      const saved = await chrome.storage.local.get(VERSION_KEY);
      if (saved[VERSION_KEY] === version) return;
      const state = await read();
      state.enabled = false;
      for (const worker of state.workers) {
        if (!RUNNING.has(worker.status)) continue;
        worker.status = 'error';
        worker.message = 'Расширение обновлено во время прохода. Черновики сохранены.';
        const item = findItem(state, worker.itemId);
        if (item) {
          item.status = 'error';
          item.error = worker.message;
        }
        await syncWorker(worker);
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: state, [VERSION_KEY]: version });
    });
  }

  return {
    getState: async () => publicState(await read()),
    enqueue, change, remove, retry, enable, cancel, progress, checkpoint,
    authorized, complete, failed, tabClosed, tabNavigated, tick, versionCheck
  };
}
