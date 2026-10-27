// A rejected completion must remain discoverable as a full-size draft.
// Never shrink, discard, or overwrite a previously completed canonical chat
// merely because the extension could not validate its current capture.
export function buildRejectedCaptureDraft(archive, job = {}, error = '') {
  if (!archive?.id || !Array.isArray(archive.messages)) {
    throw new Error('Captured archive and its messages are required');
  }
  const fallbackBoundary = archive.captureBoundaryKind && archive.captureBoundaryKey
    ? {
      kind: archive.captureBoundaryKind,
      key: archive.captureBoundaryKey,
      role: archive.captureBoundaryRole || ''
    }
    : null;
  const messages = archive.messages;
  const images = messages.flatMap(item => item.images || []);
  return {
    ...archive,
    id: 'rejected-finalize:' + archive.id,
    kind: 'capture-draft',
    recoveredFromArchiveId: archive.id,
    captureMode: job.captureMode || archive.lastCaptureMode || 'full',
    capturePhase: 'finalizing',
    captureBoundary: job.captureBoundary || fallbackBoundary,
    captureRange: job.captureRange || archive.manualRangeMarkers || null,
    chronologicalCount: messages.length,
    imageCount: images.length,
    imageBinaryReady: images.filter(img => img?.binaryStatus === 'ready' && img.dataUrl).length,
    imageBinaryFailed: images.filter(img => img?.binaryStatus === 'failed').length,
    messages,
    partial: true,
    complete: false,
    error: String(error || 'Не удалось подтвердить завершение сбора.')
  };
}
