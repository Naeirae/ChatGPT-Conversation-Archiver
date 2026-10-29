// Read-only health classification for a single live capture. A warning is not
// authorization to stop a collector or discard its checkpoint.
export function shouldInspectCapture(job, now = Date.now(), {
  idleMs = 180000,
  intervalMs = 120000
} = {}) {
  if (!job || !['starting', 'running'].includes(job.status) || !job.jobId) return false;
  const countEvidenceAt = Number(job.lastCountAdvanceAt || job.startedAt || 0);
  if (!countEvidenceAt || now - countEvidenceAt < idleMs) return false;
  const lastDiagnosticAt = Number(job.lastStallDiagnosticAt || 0);
  return !lastDiagnosticAt || now - lastDiagnosticAt >= intervalMs;
}

export function captureStallEvidence(job, tab, health, now = Date.now()) {
  const lastCountAt = Number(job.lastCountAdvanceAt || job.startedAt || now);
  const lastProgressAt = Number(job.lastProgressAt || 0);
  const lastPhysicalAt = Number(job.lastPhysicalScrollAt || 0);
  const live = Boolean(health?.ok && health.jobId === job.jobId && health.running);
  const status = health?.ok
    ? (live ? health.paused ? 'paused-in-page' : 'running-in-page' : 'not-running-in-page')
    : 'no-health-response';
  return {
    status,
    countIdleSeconds: Math.max(0, Math.floor((now - lastCountAt) / 1000)),
    progressIdleSeconds: lastProgressAt
      ? Math.max(0, Math.floor((now - lastProgressAt) / 1000)) : null,
    wheelIdleSeconds: lastPhysicalAt
      ? Math.max(0, Math.floor((now - lastPhysicalAt) / 1000)) : null,
    tabFrozen: tab?.frozen === true,
    pageVisibility: health?.visibility || 'unknown',
    lastScrollActivity: String(job.lastPhysicalActivity || 'unknown'),
    lastScrollBefore: job.lastScrollBefore ?? null,
    lastScrollAfter: job.lastScrollAfter ?? null,
    count: Number(job.count || 0)
  };
}

export function stallDiagnosticText(evidence) {
  const seconds = value => value == null ? 'unknown' : value + 's';
  return [
    'Зафиксирован длительный период без новых сообщений (' +
      seconds(evidence.countIdleSeconds) + ').',
    'Content script: ' + evidence.status + '.',
    'Chrome frozen: ' + (evidence.tabFrozen ? 'yes' : 'no') + '.',
    'Page visibility: ' + evidence.pageVisibility + '.',
    'Last progress: ' + seconds(evidence.progressIdleSeconds) + '.',
    'Last wheel: ' + seconds(evidence.wheelIdleSeconds) + '.',
    'Wheel result: ' + evidence.lastScrollActivity + ' (' +
      String(evidence.lastScrollBefore ?? '?') + ' -> ' +
      String(evidence.lastScrollAfter ?? '?') + ').'
  ].join(' ');
}
