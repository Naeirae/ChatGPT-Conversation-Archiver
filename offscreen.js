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



function withTimeout(promise, timeoutMs, label = 'Операция') {
  const ms = Math.max(1000, Number(timeoutMs) || 8000);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(label + ' не завершилась за ' + Math.round(ms / 1000) + ' с.')),
        ms
      );
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function writeImageWithExecCommand(dataUrl, alt = '') {
  const source = String(dataUrl || '');
  if (!/^data:image\//i.test(source)) {
    throw new Error('Нет подготовленных бинарных данных изображения.');
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
    if (img.decode) {
      await withTimeout(
        img.decode(),
        8000,
        'Декодирование изображения для Google Docs'
      );
    } else if (!img.complete) {
      await withTimeout(
        new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Изображение не декодировалось в offscreen clipboard.'));
        }),
        8000,
        'Загрузка изображения для Google Docs'
      );
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
      method: 'offscreen-image-selection',
      size: source.length
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
        String(message.dataUrl || ''),
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
