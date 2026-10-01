function writeWithExecCommand(html, text) {
  const host = document.createElement('div');
  host.setAttribute('contenteditable', 'true');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.opacity = '0';
  host.innerHTML = html || '';

  if (!host.innerHTML && text) {
    host.textContent = text;
  }

  document.body.appendChild(host);

  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(host);
  selection.removeAllRanges();
  selection.addRange(range);

  let copyEventSeen = false;
  const onCopy = event => {
    copyEventSeen = true;
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/html', String(html || ''));
    event.clipboardData.setData('text/plain', String(text || ''));
  };

  document.addEventListener('copy', onCopy, true);
  try {
    const ok = document.execCommand('copy');
    if (!ok && !copyEventSeen) {
      throw new Error('Chrome отклонил команду копирования.');
    }
  } finally {
    document.removeEventListener('copy', onCopy, true);
    selection.removeAllRanges();
    host.remove();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ARCHIVER_OFFSCREEN_WRITE' || message?.target !== 'offscreen') return;

  (async () => {
    // Offscreen documents cannot receive focus, so navigator.clipboard.write()
    // fails with "Document is not focused" on current Chrome. Chrome's own
    // extension migration guidance recommends selection + execCommand('copy')
    // for offscreen clipboard work.
    writeWithExecCommand(String(message.html || ''), String(message.text || ''));
    return { ok: true };
  })().then(sendResponse).catch(error => sendResponse({
    ok: false,
    error: error?.message || String(error)
  }));

  return true;
});
