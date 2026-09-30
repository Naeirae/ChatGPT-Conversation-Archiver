chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ARCHIVER_OFFSCREEN_WRITE' || message?.target !== 'offscreen') return;
  (async () => {
    const item = new ClipboardItem({
      'text/html': new Blob([String(message.html || '')], { type: 'text/html' }),
      'text/plain': new Blob([String(message.text || '')], { type: 'text/plain' })
    });
    await navigator.clipboard.write([item]);
    return { ok: true };
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
