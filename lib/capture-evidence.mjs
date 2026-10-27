// Capture completeness is based on observed boundaries, never the number of
// visible messages. A seven-message conversation can be complete; a seven-turn
// virtualized viewport in a huge conversation is not proof of completeness.

export function fullTopEvidence({
  explicitConversationStart = false,
  manuallyConfirmed = false,
  upwardTravelObserved = false,
  stableChecks = 0
} = {}) {
  if (manuallyConfirmed) {
    return { verified: true, source: 'user-confirmed-start' };
  }
  if (explicitConversationStart) {
    return { verified: true, source: 'visible-first-turn' };
  }
  if (upwardTravelObserved && stableChecks >= 5) {
    return { verified: true, source: 'upward-traversal-and-stability' };
  }
  return {
    verified: false,
    source: '',
    reason: upwardTravelObserved
      ? 'Не удалось подтвердить устойчивое начало переписки после прокрутки вверх.'
      : 'Вкладка не прокручивалась вверх, а первая реплика не подтверждена. Нельзя считать видимые сообщения полным чатом.'
  };
}

export function completedBoundedPass({
  mode = 'full',
  verifiedStart = false,
  verifiedEnd = false,
  markerStartVisible = false,
  markerEndVisible = false
} = {}) {
  // If the explicitly marked start and end are in the same real viewport,
  // there need not be any physical scrolling, even for a one-turn chat.
  if (mode === 'fragment') {
    return Boolean(markerStartVisible && markerEndVisible && verifiedEnd);
  }
  return Boolean(verifiedStart && verifiedEnd);
}
