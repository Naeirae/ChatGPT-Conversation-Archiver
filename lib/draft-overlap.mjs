import { normalizeDisplayText } from './text.mjs';
import { conversationKey } from './urls.mjs';

function boundaryIdentity(draft) {
  const kind = draft?.boundaryKind || draft?.captureBoundary?.kind || '';
  const key = draft?.boundaryKey || draft?.captureBoundary?.key || '';
  return kind && key ? String(kind) + ':' + String(key) : '';
}

function manualRangeIdentity(draft) {
  const range = draft?.captureRange || draft?.manualFullRange || draft?.fragmentMarkers || {};
  const start = range.start || {};
  const end = range.end || {};
  const a = String(start.id || start.signature || '');
  const b = String(end.id || end.signature || '');
  return a || b ? 'start:' + (a || 'open') + ':end:' + (b || 'open') : 'full-range';
}

// Chat title is never evidence of identity. Require the same URL conversation
// key, the same immutable snapshot end boundary and the same marked range.
export function sameDraftCaptureScope(left, right) {
  const aSource = conversationKey(left?.sourceUrl || '');
  const bSource = conversationKey(right?.sourceUrl || '');
  const aBoundary = boundaryIdentity(left);
  const bBoundary = boundaryIdentity(right);
  return Boolean(aSource && aSource === bSource &&
    aBoundary && aBoundary === bBoundary &&
    manualRangeIdentity(left) === manualRangeIdentity(right));
}


// A message's generated ordinal/test ID is not a stable cross-run identity.
function strongId(message) {
  const id = String(message?.id || '');
  return message?.identityStrong || /^(?:data-message-id|data-turn-id):/.test(id)
    ? id : '';
}

function normalizedText(message) {
  // Unlike search matching, archival identity must preserve list markers,
  // numbering and other meaningful presentation distinctions.
  return normalizeDisplayText(message?.text || '').replace(/\s+/g, ' ').trim();
}

// Keep repeated equal utterances distinct when ChatGPT exposes distinct stable
// IDs. Text equality alone is allowed only as supporting sequence evidence.
export function sameStoredTurn(left, right) {
  if (!left || !right || left.role !== right.role) return false;
  const a = strongId(left);
  const b = strongId(right);
  if (a && b && a !== b) return false;

  const aText = normalizedText(left);
  const bText = normalizedText(right);
  if (aText && bText && aText !== bText) return false;
  if (a && b) return true;
  return Boolean(aText && bText && aText === bText);
}

function anchorTokens(message) {
  const id = strongId(message);
  // Long repeated paragraphs can occur in distinct saved attempts. Text is
  // supporting evidence after an immutable DOM turn anchor, never an anchor.
  return id ? ['id:' + id] : [];
}

// Align two chronological windows, not just prefixes. An overlap is accepted
// only when (a) all paired turns match, (b) the placement is unique, and (c)
// evidence includes a shared stable turn ID. Weak text alone is not sufficient.
// Ambiguity, repeated short replies and disconnected windows remain separate.
export function verifiedChronologicalOverlap(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) ||
      left.length < 2 || right.length < 2) return null;

  const index = new Map();
  for (let i = 0; i < left.length; i++) {
    for (const token of anchorTokens(left[i])) {
      if (!index.has(token)) index.set(token, []);
      index.get(token).push(i);
    }
  }

  const candidateOffsets = new Set();
  for (let j = 0; j < right.length; j++) {
    for (const token of anchorTokens(right[j])) {
      const positions = index.get(token) || [];
      // Repetitive material without reliable positioning is not a merge key.
      if (positions.length > 12) continue;
      for (const i of positions) {
        const offset = i - j; // right[0] positioned at left[offset]
        const leftStart = Math.max(0, offset);
        const rightStart = Math.max(0, -offset);
        const overlap = Math.min(left.length - leftStart, right.length - rightStart);
        if (overlap < 2) continue;
        candidateOffsets.add(offset);
        if (candidateOffsets.size > 64) return null;
      }
    }
  }

  let accepted = null;
  for (const offset of candidateOffsets) {
    const leftStart = Math.max(0, offset);
    const rightStart = Math.max(0, -offset);
    const overlap = Math.min(left.length - leftStart, right.length - rightStart);
    let matching = true;
    let strongMatches = 0;
    for (let k = 0; k < overlap; k++) {
      const a = left[leftStart + k];
      const b = right[rightStart + k];
      if (!sameStoredTurn(a, b)) {
        matching = false;
        break;
      }
      if (strongId(a) && strongId(a) === strongId(b)) strongMatches++;
    }
    if (!matching || strongMatches < 1) continue;
    if (accepted) return null; // more than one valid placement
    const lower = Math.min(0, offset);
    accepted = {
      offset,
      leftStart,
      rightStart,
      overlap,
      mergedLength: Math.max(left.length, offset + right.length) - lower,
      leftEndIndex: left.length - 1 - lower,
      rightEndIndex: offset + right.length - 1 - lower,
      startShift: -lower
    };
  }
  return accepted;
}

// The newer saved checkpoint is authoritative for conflicting *ready* image
// bodies and richer text payloads. An older checkpoint may still contribute
// missing images. The caller merges the chosen primary with the secondary.
export function mergeNewestCapturedTurn(left, right, mergePayload) {
  if (typeof mergePayload !== 'function') throw new TypeError('mergePayload is required');
  const leftTime = Number(left?.__captureTime || 0);
  const rightTime = Number(right?.__captureTime || 0);
  return rightTime > leftTime
    ? mergePayload(right, left)
    : mergePayload(left, right);
}

export function mergeVerifiedTurns(left, right, alignment, mergeTurn = (a) => a) {
  if (!alignment || !Array.isArray(left) || !Array.isArray(right)) {
    throw new Error('Chronological alignment is required');
  }
  const checked = verifiedChronologicalOverlap(left, right);
  if (!checked || checked.offset !== alignment.offset ||
      checked.overlap !== alignment.overlap) {
    throw new Error('Chronological overlap is not uniquely verified');
  }
  const merged = Array(checked.mergedLength);
  for (let i = 0; i < left.length; i++) merged[i + checked.startShift] = left[i];
  for (let j = 0; j < right.length; j++) {
    const position = j + checked.offset + checked.startShift;
    const existing = merged[position];
    if (existing) {
      if (!sameStoredTurn(existing, right[j])) {
        throw new Error('Conflicting turns inside verified overlap');
      }
      merged[position] = mergeTurn(existing, right[j]);
    } else {
      merged[position] = right[j];
    }
  }
  if (merged.some(item => !item)) throw new Error('Gap in merged chronological sequence');
  return {
    messages: merged,
    leftEndIndex: checked.leftEndIndex,
    rightEndIndex: checked.rightEndIndex,
    startShift: checked.startShift
  };
}


// Build user-facing chains without changing or deleting the source drafts.
// A component may span several overlapping windows. A later bridge may join
// two components only when their combined chronology aligns unambiguously.
export function groupVerifiedDraftComponents(drafts = [], mergeTurn = a => a) {
  const components = [];
  for (const draft of drafts || []) {
    if (!draft?.id || !Array.isArray(draft.messages) || !draft.messages.length) {
      components.push({ scope: draft, messages: draft?.messages || [], drafts: [draft] });
      continue;
    }
    let attached = false;
    for (const component of components) {
      if (!sameDraftCaptureScope(draft, component.scope)) continue;
      const overlap = verifiedChronologicalOverlap(component.messages, draft.messages);
      if (!overlap) continue;
      component.messages = mergeVerifiedTurns(component.messages, draft.messages, overlap, mergeTurn).messages;
      component.drafts.push(draft);
      attached = true;
      break;
    }
    if (!attached) {
      components.push({ scope: draft, messages: draft.messages, drafts: [draft] });
    }
  }

  // Joining a bridge window can make previously disconnected components
  // adjacent. Do not equate shared titles, a single turn, or arbitrary texts.
  let linked = true;
  while (linked) {
    linked = false;
    for (let i = 0; i < components.length && !linked; i++) {
      for (let j = i + 1; j < components.length; j++) {
        const left = components[i];
        const right = components[j];
        if (!sameDraftCaptureScope(left.scope, right.scope)) continue;
        const overlap = verifiedChronologicalOverlap(left.messages, right.messages);
        if (!overlap) continue;
        left.messages = mergeVerifiedTurns(left.messages, right.messages, overlap, mergeTurn).messages;
        left.drafts.push(...right.drafts);
        components.splice(j, 1);
        linked = true;
        break;
      }
    }
  }
  return components;
}

export function groupVerifiedDraftWindows(drafts = []) {
  return groupVerifiedDraftComponents(drafts).map(component => component.drafts);
}
