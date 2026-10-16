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



async function writeImageWithExecCommand(sourceValue, alt = '') {
  const source = String(sourceValue || '').trim();
  if (!/^data:image\//i.test(source) && !/^https?:\/\//i.test(source)) {
    throw new Error('Нет доступного источника изображения для буфера обмена.');
  }

  const host = document.createElement('div');
  host.setAttribute('contenteditable', 'true');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.opacity = '0';

  const img = document.createElement('img');
  img.src = source;
  img.alt = String(alt || '');
  host.appendChild(img);
  document.body.appendChild(host);

  try {
    await Promise.race([
      img.decode
        ? img.decode()
        : new Promise((resolve, reject) => {
            if (img.complete && img.naturalWidth) return resolve();
            img.onload = resolve;
            img.onerror = () => reject(new Error('Изображение не загрузилось.'));
          }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Изображение не загрузилось за 15 секунд.')), 15000)
      )
    ]);

    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error('Изображение загрузилось без размеров.');
    }

    const selection = getSelection();
    const range = document.createRange();
    range.selectNode(img);
    selection.removeAllRanges();
    selection.addRange(range);

    const ok = document.execCommand('copy');
    selection.removeAllRanges();
    if (!ok) throw new Error('Chrome отклонил копирование изображения.');

    return {
      ok: true,
      method: /^data:image\//i.test(source)
        ? 'offscreen-data-image-selection'
        : 'offscreen-remote-image-selection',
      size: source.length,
      width: img.naturalWidth,
      height: img.naturalHeight
    };
  } finally {
    getSelection()?.removeAllRanges?.();
    host.remove();
  }
}

function readWithExecCommand() {
  const host = document.createElement('textarea');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.opacity = '0';
  document.body.appendChild(host);

  host.focus();
  host.select();

  try {
    const ok = document.execCommand('paste');
    if (!ok && !host.value) {
      throw new Error('Chrome отклонил чтение буфера обмена.');
    }
    return host.value || '';
  } finally {
    host.remove();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  (async () => {
    if (message?.type === 'ARCHIVER_OFFSCREEN_WRITE') {
      // Offscreen documents cannot receive focus, so navigator.clipboard.write()
      // fails with "Document is not focused" on current Chrome. Selection +
      // execCommand('copy') works with the extension clipboard permission.
      writeWithExecCommand(String(message.html || ''), String(message.text || ''));
      return { ok: true };
    }

    if (message?.type === 'ARCHIVER_OFFSCREEN_WRITE_IMAGE') {
      return await writeImageWithExecCommand(
        String(message.dataUrl || message.src || ''),
        String(message.alt || '')
      );
    }

    if (message?.type === 'ARCHIVER_OFFSCREEN_READ') {
      return { ok: true, text: readWithExecCommand() };
    }

    return null;
  })().then(sendResponse).catch(error => sendResponse({
    ok: false,
    error: error?.message || String(error)
  }));

  return true;
});
