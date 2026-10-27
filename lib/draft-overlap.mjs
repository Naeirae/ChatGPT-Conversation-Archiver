import { messageSignature, normalizeMatchText } from './text.mjs';

// A message's generated ordinal/test ID is not a stable cross-run identity.
function strongId(message) {
  const id = String(message?.id || '');
  return message?.identityStrong || /^(?:data-message-id|data-turn-id):/.test(id)
    ? id : '';
}

function normalizedText(message) {
  return normalizeMatchText(message?.text || '');
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
  const tokens = [];
  const id = strongId(message);
  if (id) tokens.push('id:' + id);
  const text = normalizedText(message);
  if (text.length >= 24) tokens.push('text:' + messageSignature(message.role, text));
  return tokens;
}

// Align two chronological windows, not just prefixes. An overlap is accepted
// only when (a) all paired turns match, (b) the placement is unique, and (c)
// evidence contains a stable turn ID or at least two substantial text turns.
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
    let substantialMatches = 0;
    for (let k = 0; k < overlap; k++) {
      const a = left[leftStart + k];
      const b = right[rightStart + k];
      if (!sameStoredTurn(a, b)) {
        matching = false;
        break;
      }
      if (strongId(a) && strongId(a) === strongId(b)) strongMatches++;
      if (normalizedText(a).length >= 24 && normalizedText(b).length >= 24) {
        substantialMatches++;
      }
    }
    if (!matching || !(strongMatches >= 1 || substantialMatches >= 2)) continue;
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
