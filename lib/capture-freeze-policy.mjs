// Chrome's frozen state is a transient browser lifecycle signal, not a
// user-requested Pause. Capture progress and checkpoints remain authoritative.
export function freezeTransition(job, frozen, at = Date.now()) {
  if (!job || !['starting','running','paused'].includes(job.status) ||
      typeof frozen !== 'boolean') return null;
  if (frozen) {
    if (job.tabFrozen === true) return null;
    return {
      patch: {
        tabFrozen: true, tabFrozenAt: at,
        ...(job.status === 'paused' ? {} : {
          message: 'Chrome временно заморозил вкладку; сохраняю активный проход и жду возобновления выполнения.'
        })
      },
      event: 'CAPTURE_TAB_FROZEN',
      requiresHealth: false
    };
  }
  if (job.tabFrozen !== true && job.pauseReason !== 'frozen') return null;
  const legacySystemPause = job.status === 'paused' && job.pauseReason === 'frozen';
  return {
    patch: {
      tabFrozen: false, tabThawedAt: at,
      ...(legacySystemPause ? {
        status: 'running', phase: job.resumePhase || 'top', pauseReason: '',
        message: 'Вкладка разморожена; продолжаю прежний проход.'
      } : job.status === 'paused' ? {} : {
        message: 'Вкладка разморожена; сбор продолжает выполнение.'
      })
    },
    event: legacySystemPause ? 'CAPTURE_SYSTEM_PAUSE_RESUMED' : 'CAPTURE_TAB_THAWED',
    requiresHealth: legacySystemPause
  };
}
