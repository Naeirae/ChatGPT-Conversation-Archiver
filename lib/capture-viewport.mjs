// A node may be present in ChatGPT's virtualized DOM while it is located
// outside the actual visible scrollport. DOM presence is not boundary arrival.
function normalizedRect(rect) {
  if (!rect) return null;
  const top = Number(rect.top);
  const left = Number(rect.left);
  const right = Number(rect.right);
  const bottom = Number(rect.bottom);
  if (![top, left, right, bottom].every(Number.isFinite)) return null;
  if (right <= left || bottom <= top) return null;
  return { top, left, right, bottom };
}

export function rectIntersectsCaptureViewport(
  targetRect, viewportWidth, viewportHeight, scrollportRect = null, minPixels = 2
) {
  const target = normalizedRect(targetRect);
  const width = Number(viewportWidth);
  const height = Number(viewportHeight);
  if (!target || !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) return false;
  let left = Math.max(target.left, 0);
  let top = Math.max(target.top, 0);
  let right = Math.min(target.right, width);
  let bottom = Math.min(target.bottom, height);
  if (scrollportRect) {
    const scrollport = normalizedRect(scrollportRect);
    if (!scrollport) return false;
    left = Math.max(left, scrollport.left);
    top = Math.max(top, scrollport.top);
    right = Math.min(right, scrollport.right);
    bottom = Math.min(bottom, scrollport.bottom);
  }
  const threshold = Math.max(1, Number(minPixels) || 2);
  return right - left >= threshold && bottom - top >= threshold;
}

// A genuine DOM message ID is immutable evidence. Previous messages may have
// been virtualized away, so a strong ID must NOT require its old neighbours.
export function matchesStrongBoundaryIdentity(
  expectedId, observedId, observedSignature, expectedSignature
) {
  const strong = id => /^(?:data-message-id|data-turn-id):/.test(String(id || ''));
  if (!strong(expectedId)) return null;
  if (strong(observedId)) return expectedId === observedId;
  // A rendering may temporarily lose the ID. This is not proof of identity.
  return false;
}
