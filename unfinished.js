const $ = id => document.getElementById(id);

const PHASE_NAMES = {
  top: 'путь к началу',
  walk: 'сохранение сверху вниз',
  finalizing: 'завершение сохранения',
  paused: 'пауза'
};

const MODE_NAMES = {
  full: 'полный сбор',
  fragment: 'фрагмент',
  continue: 'продолжение архива',
  sync: 'восстановление по документу Google Docs',
  images: 'сверка и добор изображений',
  'images-draft': 'сверка изображений незавершённой части',
  reconcile: 'сверка и добор сообщений',
  'manual-full': 'ручной полный диапазон',
  'resume-draft': 'продолжение незавершённого сбора',
  'retry-walk': 'повтор прохода сверху вниз'
};

function passIdFromUrl() {
  return new URL(location.href).searchParams.get('passId') || '';
}

function formatDate(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('ru-RU'); } catch (_) { return String(value); }
}

function renderMessage(message, index) {
  const card = document.createElement('article');
  card.className = 'message';

  const head = document.createElement('div');
  head.className = 'message-head';
  const role = document.createElement('strong');
  role.textContent = message.role === 'user' ? 'Пользователь' : 'ChatGPT';
  const number = document.createElement('span');
  number.textContent = '#' + (index + 1);
  head.append(role, number);

  const body = document.createElement('pre');
  body.textContent = message.text || ((message.images || []).length ? '[изображение]' : '[пустая реплика]');

  const extra = document.createElement('div');
  extra.className = 'message-extra';
  const parts = [];
  if ((message.images || []).length) parts.push('изображений: ' + message.images.length);
  if (message.reasoningHtml) parts.push('есть служебное рассуждение');
  if (message.id) parts.push('служебный номер: ' + message.id);
  extra.textContent = parts.join(' · ');

  card.append(head, body);
  if (parts.length) card.append(extra);
  if (index === window.__unfinishedLastIndex) {
    card.classList.add('last-saved');
    card.id = 'lastSavedMessage';
    const marker = document.createElement('div');
    marker.className = 'last-marker';
    marker.textContent = 'Последнее сохранённое сообщение';
    card.append(marker);
  }
  return card;
}

async function load() {
  const passId = passIdFromUrl();
  if (!passId) throw new Error('Не указан незавершённый сбор.');

  const result = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_GET_UNFINISHED_PASS',
    passId
  });
  if (!result?.ok || !result.unfinishedPass) {
    throw new Error(result?.error || 'Сохранённый незавершённый сбор не найден.');
  }

  const pass = result.unfinishedPass;
  $('title').textContent = pass.title || 'Незавершённый сбор';

  const meta = [
    'Сохранено: ' + formatDate(pass.capturedAt),
    'Сообщений: ' + ((pass.messages || []).length),
    'Изображений: ' + (pass.imageCount || 0),
    'Подготовлено изображений: ' + (pass.imageBinaryReady || 0),
    'Не подготовлено изображений: ' + (pass.imageBinaryFailed || 0),
    'Этап сбора: ' + (PHASE_NAMES[pass.capturePhase] || '—'),
    'Режим: ' + (MODE_NAMES[pass.captureMode] || 'обычный сбор'),
    'Найдено на первом этапе: ' + (pass.navigationHighWater || 0),
    'Нижняя граница снимка: ' + (pass.captureBoundary?.key ? 'есть' : 'нет')
  ];
  $('meta').textContent = meta.join(' · ');
  $('error').textContent = pass.error || '';

  $('messageCount').textContent = (pass.messages || []).length + ' сообщений';
  window.__unfinishedLastIndex = Math.max(0, (pass.messages || []).length - 1);
  const list = $('messages');
  list.textContent = '';
  (pass.messages || []).forEach((message, index) => list.appendChild(renderMessage(message, index)));

  const state = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_STATE' }).catch(() => null);
  const passState = (state?.unfinishedPasses || []).find(item =>
    item.id === passId || (item.passIds || []).includes(passId)
  ) || null;
  const hasSavedRecoveryTab = Boolean(passState?.recoveryTabAvailable);
  const canResume = Boolean(pass.captureBoundary?.kind && pass.captureBoundary?.key && pass.sourceUrl);
  $('resume').classList.toggle('hidden', !canResume);
  $('resume').textContent = 'Продолжить';
  $('openCapture').classList.toggle('hidden', !hasSavedRecoveryTab);
  const isChronologicalPrefix = ['walk', 'finalizing'].includes(pass.capturePhase || '');
  $('exportDoc').classList.toggle('hidden', !isChronologicalPrefix);
  $('reconcileArchive').classList.toggle('hidden', !isChronologicalPrefix);
  $('hydrateImages').classList.toggle('hidden', !isChronologicalPrefix);
  $('hydrateImages').textContent = 'Сверить и добрать изображения';

  const compared = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_COMPARE_UNFINISHED_PASS',
    passId
  });
  if (compared?.ok) {
    if (!compared.archive) {
      $('compare').textContent =
        'Завершённого локального архива этого чата сейчас нет. В незавершённом проходе: ' +
        (compared.unfinishedPass?.messageCount || 0) + ' сообщений.';
    } else {
      $('compare').textContent = [
        'Завершённый архив: ' + (compared.archive.messageCount || 0),
        'незавершённый сбор: ' + (compared.unfinishedPass?.messageCount || 0),
        'общая начальная часть: ' + (compared.commonPrefixCount || 0),
        'совпадающих сообщений: ' + (compared.sharedCount || 0),
        'только в незавершённом проходе: ' + (compared.onlyInUnfinishedPassCount || 0),
        'только в завершённом архиве: ' + (compared.onlyInArchiveCount || 0)
      ].join(' · ');
    }
  } else {
    $('compare').textContent = compared?.error || 'Сверку выполнить не удалось.';
  }
}

$('reconcileArchive').onclick = async () => {
  const passId = passIdFromUrl();
  $('reconcileArchive').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_RECONCILE_UNFINISHED_PASS',
      passId
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сверить незавершённый сбор.');
    $('compare').textContent =
      'Локальный архив обновлён: было ' + Number(result.previousMessageCount || 0) +
      ', стало ' + Number(result.messageCount || 0) +
      ', восстановлено ' + Number(result.addedCount || 0) + ' сообщений.';
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    $('reconcileArchive').disabled = false;
  }
};

$('hydrateImages').onclick = async () => {
  const passId = passIdFromUrl();
  $('hydrateImages').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_HYDRATE_UNFINISHED_IMAGES',
      passId
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось добрать изображения.');
    alert('Сверка изображений сохранённой части запущена. Прогресс виден в основном окне Архиватора.');
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    $('hydrateImages').disabled = false;
  }
};

$('copy').onclick = async () => {
  const passId = passIdFromUrl();
  const result = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_COPY_UNFINISHED_PASS',
    passId
  });
  if (!result?.ok) alert(result?.error || 'Не удалось скопировать незавершённый сбор.');
};

$('delete').onclick = async () => {
  const passId = passIdFromUrl();
  if (!confirm('Удалить этот сохранённый незавершённый сбор?')) return;
  const result = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_DELETE_UNFINISHED_PASS',
    passId
  });
  if (!result?.ok) {
    alert(result?.error || 'Не удалось удалить незавершённый сбор.');
    return;
  }
  document.body.innerHTML = '<main><section class="card"><h1>Незавершённый сбор удалён</h1></section></main>';
};

load().catch(error => {
  $('meta').textContent = error.message || String(error);
  $('compare').textContent = '';
});


$('jumpLast').onclick = () => {
  const target = document.getElementById('lastSavedMessage');
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

$('openCapture').onclick = async () => {
  const passId = passIdFromUrl();
  const result = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_FOCUS_UNFINISHED_RECOVERY_TAB',
    passId
  });
  if (!result?.ok) alert(result?.error || 'Не удалось открыть сохранённую вкладку сбора.');
};

$('resume').onclick = async () => {
  const passId = passIdFromUrl();
  const state = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_STATE' }).catch(() => null);
  const passState = (state?.unfinishedPasses || []).find(item => item.id === passId) || null;
  const hasSavedRecoveryTab = Boolean(passState?.recoveryTabAvailable);
  const result = await chrome.runtime.sendMessage(
    hasSavedRecoveryTab
      ? { type: 'ARCHIVER_RESUME_UNFINISHED_IN_SAVED_TAB', passId }
      : {
          type: 'ARCHIVER_RESUME_UNFINISHED_PASS',
          passId,
          captureTarget: 'copy',
          resumeStrategy: 'fresh'
        }
  );
  if (!result?.ok) {
    alert(result?.error || 'Не удалось продолжить незавершённый сбор.');
    return;
  }
  alert(
    hasSavedRecoveryTab
      ? 'Архиватор продолжает сбор в той же сохранённой вкладке.'
      : 'Архиватор восстанавливает сохранённый участок и продолжает сбор.'
  );
};


$('exportDoc').onclick = async () => {
  const passId = passIdFromUrl();
  $('exportDoc').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_EXPORT_UNFINISHED_NEW_DOC',
      passId
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить текущую часть в Google Docs.');
    alert(
      'В Google Docs сохранена текущая часть: ' +
      Number(result.exportedMessageCount || result.addedCount || 0) +
      ' сообщений. Позже документ можно сверить с продолжением чата.'
    );
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    $('exportDoc').disabled = false;
  }
};
