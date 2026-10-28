import { conversationKey } from './urls.mjs';
import { verifiedChronologicalOverlap, mergeVerifiedTurns } from './draft-overlap.mjs';

export const QUEUE_MODES = Object.freeze({
  TWO_CHATS: 'two-chats',
  SPLIT_CHAT: 'split-chat'
});
export const QUEUE_CAPACITY = 2;
const ACTIVE = new Set(['starting', 'running', 'paused', 'stopping']);

export function normalizeQueueMode(mode) {
  if (mode === QUEUE_MODES.TWO_CHATS || mode === QUEUE_MODES.SPLIT_CHAT) return mode;
  throw new Error('Неизвестный режим сбора очереди.');
}

export function strongQueueAnchor(anchor) {
  return Boolean(anchor && /^(?:data-message-id|data-turn-id):/.test(String(anchor.id || '')));
}

export function splitLanePlan(markers = {}) {
  const { start, middle, end } = markers;
  const previous = middle?.previous || null;
  const next = middle?.next || null;
  const anchors = [start, previous, middle, next, end];
  if (!anchors.every(strongQueueAnchor)) {
    throw new Error(
      'Для экспериментального разделения отметьте начало, середину с видимыми соседними репликами и конец. ' +
      'Нужны устойчивые ID всех пяти опорных реплик; слабые DOM-индексы не подходят.'
    );
  }
  const ids = anchors.map(anchor => anchor.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Отметки и соседние реплики не должны совпадать.');
  }
  return [
    { lane: 'first', mode: 'fragment', captureRange: { start, end: next } },
    { lane: 'second', mode: 'fragment', captureRange: { start: previous, end } }
  ];
}

export function queueLanePlan(item = {}) {
  const mode = normalizeQueueMode(item.mode);
  if (!conversationKey(item.sourceUrl || '')) {
    throw new Error('Добавьте ссылку на конкретную переписку ChatGPT.');
  }
  return mode === QUEUE_MODES.TWO_CHATS
    ? [{ lane: 'single', mode: 'full', captureRange: null }]
    : splitLanePlan(item.captureRange);
}

export function chooseRunnableQueueItems(items = [], workers = [], maxSlots = QUEUE_CAPACITY) {
  const active = workers.filter(worker => ACTIVE.has(worker?.status));
  let remaining = Math.max(0, maxSlots - active.length);
  const selected = [];
  const activeSources = new Set(active.map(worker => conversationKey(worker.sourceUrl)).filter(Boolean));
  for (const item of items) {
    if (item?.status !== 'queued') continue;
    const key = conversationKey(item.sourceUrl || '');
    if (!key || activeSources.has(key)) continue; // no two unrelated captures of same source
    const completedLanes = new Set(workers.filter(worker =>
      worker.itemId === item.id && worker.status === 'done'
    ).map(worker => worker.lane));
    const laneNames = item.mode === QUEUE_MODES.SPLIT_CHAT
      ? ['first', 'second'] : ['single'];
    const lanes = laneNames.filter(name => !completedLanes.has(name)).length;
    if (!lanes || lanes > remaining) continue;
    selected.push(item);
    remaining -= lanes;
    activeSources.add(key);
  }
  return selected;
}

export function queueItemStatus(item, workers = []) {
  const expected = item.mode === QUEUE_MODES.SPLIT_CHAT ? 2 : 1;
  const lanes = workers.filter(worker => worker.itemId === item.id);
  if (!lanes.length) return item.status || 'queued';
  if (lanes.some(worker => worker.status === 'error')) return 'error';
  if (lanes.some(worker => worker.status === 'cancelled')) return 'cancelled';
  if (lanes.length === expected && lanes.every(worker => worker.status === 'done')) return 'done';
  if (lanes.some(worker => worker.status === 'paused')) return 'paused';
  if (lanes.some(worker => ACTIVE.has(worker.status))) return 'running';
  return item.status || 'queued';
}

export function joinVerifiedSplitCapture(item, first, second, mergePayload = left => left) {
  const key = conversationKey(item?.sourceUrl || '');
  if (!key || !first || !second ||
      conversationKey(first.sourceUrl || '') !== key ||
      conversationKey(second.sourceUrl || '') !== key) {
    throw new Error('Части относятся к разным перепискам.');
  }
  const [leftPlan, rightPlan] = splitLanePlan(item.captureRange);
  const left = first.messages || [];
  const right = second.messages || [];
  if (!left.length || !right.length ||
      !first.captureProof?.startVerified || !first.captureProof?.endVerified ||
      !second.captureProof?.startVerified || !second.captureProof?.endVerified) {
    throw new Error('Не подтверждены границы обеих частей.');
  }
  if (left[0]?.id !== leftPlan.captureRange.start.id ||
      left[left.length - 1]?.id !== leftPlan.captureRange.end.id ||
      right[0]?.id !== rightPlan.captureRange.start.id ||
      right[right.length - 1]?.id !== rightPlan.captureRange.end.id) {
    throw new Error('Фактические границы не совпали с отметками двух потоков.');
  }
  const alignment = verifiedChronologicalOverlap(left, right);
  if (!alignment || alignment.overlap < 2) {
    throw new Error('Не найден уникальный доказанный стык между потоками.');
  }
  const result = mergeVerifiedTurns(left, right, alignment, mergePayload);
  const messages = result.messages;
  if (messages[0]?.id !== item.captureRange.start.id ||
      messages[messages.length - 1]?.id !== item.captureRange.end.id ||
      messages.filter(message => message.id === item.captureRange.middle.id).length !== 1) {
    throw new Error('После объединения не удалось подтвердить границы и середину.');
  }
  return { messages, overlap: alignment.overlap, sourceIds: [first.id, second.id] };
}

export function queueResumePlan(draft, sourceUrl, plan) {
  // A checkpoint without independently persisted initial boundary evidence
  // is still valuable as a draft, but must not be promoted to a complete
  // archive merely because a later partial walk found the end.
  if (!draft?.id || !Array.isArray(draft.messages) || !draft.messages.length ||
      !['walk', 'finalizing'].includes(draft.capturePhase) ||
      conversationKey(draft.sourceUrl || '') !== conversationKey(sourceUrl || '') ||
      draft.captureMode !== plan?.mode ||
      !draft.captureStartProof?.startVerified ||
      !draft.captureStartProof?.snapshotEndVerified ||
      draft.captureStartProof?.mode !== plan.mode ||
      !draft.captureBoundary?.kind || !draft.captureBoundary?.key) return null;
  const last = draft.messages[draft.messages.length - 1];
  if (!strongQueueAnchor(last)) return null;
  if (plan.mode === 'fragment') {
    if (!strongQueueAnchor(plan.captureRange?.start) ||
        !strongQueueAnchor(plan.captureRange?.end) ||
        draft.captureBoundary.key !== plan.captureRange.end.id ||
        draft.captureStartProof.markedStartId !== plan.captureRange.start.id ||
        draft.captureStartProof.markedEndId !== plan.captureRange.end.id ||
        draft.captureRange?.start?.id !== plan.captureRange.start.id ||
        draft.captureRange?.end?.id !== plan.captureRange.end.id ||
        !draft.messages.some(message => message.id === plan.captureRange.start.id)) return null;
  }
  return {
    mode: 'resume-draft',
    originalMode: plan.mode,
    existingDraftId: draft.id,
    resumeAnchorId: last.id,
    resumeAnchorSignature: '',
    resumeTailSignatures: Array.isArray(draft.resumeWindowSignatures)
      ? draft.resumeWindowSignatures.slice(-6) : [],
    fixedCaptureBoundary: draft.captureBoundary,
    captureRange: plan.captureRange,
    captureStartProof: draft.captureStartProof
  };
}
