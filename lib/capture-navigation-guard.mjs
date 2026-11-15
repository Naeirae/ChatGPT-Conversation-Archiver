import { conversationKey } from './urls.mjs';

// A stale tabs.onUpdated Tab snapshot is not evidence of navigation.
// Require a URL-change event, a currently matching live-tab URL, and the
// original capture job still owning the tab.
export function confirmedCaptureNavigation({
  job,
  liveJob,
  tabId,
  eventUrl = '',
  liveUrl = '',
  eventObservedAt = 0
} = {}) {
  if (!job?.jobId || liveJob?.jobId !== job.jobId ||
      job.captureTabId !== tabId || liveJob.captureTabId !== tabId ||
      !['starting', 'running', 'paused'].includes(liveJob.status) ||
      Number(eventObservedAt) < Number(job.startedAt || 0)) return false;

  const expected = conversationKey(job.sourceUrl || '');
  const changed = conversationKey(eventUrl);
  const current = conversationKey(liveUrl);
  return Boolean(expected && changed && current &&
    changed !== expected && current === changed);
}
