const $ = id => document.getElementById(id);

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
  if (message.reasoningHtml) parts.push('есть reasoning');
  if (message.id) parts.push('id: ' + message.id);
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
  if (!passId) throw new Error('Не указан ID незавершённого прохода.');

  const result = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_GET_UNFINISHED_PASS',
    passId
  });
  if (!result?.ok || !result.unfinishedPass) {
    throw new Error(result?.error || 'Сохранённый незавершённый проход не найден.');
  }

  const pass = result.unfinishedPass;
  $('title').textContent = pass.title || 'Незавершённый проход';

  const meta = [
    'Сохранено: ' + formatDate(pass.capturedAt),
    'Сообщений: ' + ((pass.messages || []).length),
    'Изображений: ' + (pass.imageCount || 0),
    'Этап сбора: ' + (pass.capturePhase || '—'),
    'Режим: ' + (pass.captureMode || '—'),
    'Контрольный минимум первого этапа: ' + (pass.navigationHighWater || 0),
    'Нижняя snapshot-метка: ' + (pass.captureBoundary?.key ? 'есть' : 'нет')
  ];
  $('meta').textContent = meta.join(' · ');
  $('error').textContent = pass.error || '';

  $('messageCount').textContent = (pass.messages || []).length + ' сообщений';
  window.__unfinishedLastIndex = Math.max(0, (pass.messages || []).length - 1);
  const list = $('messages');
  list.textContent = '';
  (pass.messages || []).forEach((message, index) => list.appendChild(renderMessage(message, index)));

  const state = await chrome.runtime.sendMessage({ type: 'ARCHIVER_GET_STATE' }).catch(() => null);
  const passState = (state?.unfinishedPasses || []).find(item => item.id === passId) || null;
  const hasSavedRecoveryTab = Boolean(passState?.recoveryTabAvailable);
  const canResume = Boolean(pass.captureBoundary?.kind && pass.captureBoundary?.key && pass.sourceUrl);
  $('resume').classList.toggle('hidden', !canResume);
  $('resume').textContent = hasSavedRecoveryTab ? 'Продолжить в сохранённой вкладке' : 'Продолжить';
  $('openCapture').classList.toggle('hidden', !hasSavedRecoveryTab);
  $('exportDoc').classList.toggle(
    'hidden',
    !['walk', 'finalizing'].includes(pass.capturePhase || '')
  );

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
        'незавершённый проход: ' + (compared.unfinishedPass?.messageCount || 0),
        'общий префикс: ' + (compared.commonPrefixCount || 0),
        'совпадающих сообщений: ' + (compared.sharedCount || 0),
        'только в незавершённом проходе: ' + (compared.onlyInUnfinishedPassCount || 0),
        'только в завершённом архиве: ' + (compared.onlyInArchiveCount || 0)
      ].join(' · ');
    }
  } else {
    $('compare').textContent = compared?.error || 'Сверку выполнить не удалось.';
  }
}

$('copy').onclick = async () => {
  const passId = passIdFromUrl();
  const result = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_COPY_UNFINISHED_PASS',
    passId
  });
  if (!result?.ok) alert(result?.error || 'Не удалось скопировать незавершённый проход.');
};

$('delete').onclick = async () => {
  const passId = passIdFromUrl();
  if (!confirm('Удалить этот сохранённый незавершённый проход?')) return;
  const result = await chrome.runtime.sendMessage({
    type: 'ARCHIVER_DELETE_UNFINISHED_PASS',
    passId
  });
  if (!result?.ok) {
    alert(result?.error || 'Не удалось удалить незавершённый проход.');
    return;
  }
  document.body.innerHTML = '<main><section class="card"><h1>Незавершённый проход удалён</h1></section></main>';
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
    alert(result?.error || 'Не удалось продолжить незавершённый проход.');
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
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить текущую часть в Google Doc.');
    alert(
      'Текущая часть сохранена в Google Doc: ' +
      Number(result.exportedMessageCount || result.addedCount || 0) +
      ' сообщений. Позже документ можно сверить с продолжением чата.'
    );
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    $('exportDoc').disabled = false;
  }
};
