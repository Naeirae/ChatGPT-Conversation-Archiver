import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const jsFiles = [
  'service-worker.js',
  'content-chatgpt.js',
  'popup.js',
  'updater.js',
  'planner.js',
  'offscreen.js',
  'lib/text.mjs',
  'lib/urls.mjs',
  'lib/archive-store.mjs',
  'lib/google-docs-baseline.mjs',
  'lib/tab-plan.mjs'
];

const forbiddenArtifacts = [
  'updater-last.log',
  '.chatgpt-archiver-updater-state.json'
];

let failed = false;

function fail(message) {
  failed = true;
  console.error('ERROR:', message);
}

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    fail(`${file}: JavaScript syntax check failed\n${result.stderr || result.stdout}`);
  } else {
    console.log('OK:', file);
  }
}

try {
  const serviceWorkerSource = await readFile('service-worker.js', 'utf8');
  const requiredRuntimeHelpers = [
    'getActiveTab',
    'getJob',
    'setJob',
    'appendRunLog',
    'formatRunLog'
  ];
  for (const helper of requiredRuntimeHelpers) {
    const declaration = new RegExp('(?:async\\s+)?function\\s+' + helper + '\\s*\\(');
    if (!declaration.test(serviceWorkerSource)) {
      fail('service-worker.js: missing runtime helper declaration ' + helper);
    }
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_COMPARE_CURRENT'")) {
    fail('service-worker.js: missing compare-current route');
  }
  const contentSource = await readFile('content-chatgpt.js', 'utf8');
  if (!contentSource.includes("'compare'") ||
      !contentSource.includes('Сверка завершена')) {
    fail('content-chatgpt.js: missing non-mutating compare mode');
  }
  if (!contentSource.includes('REASONING_STATUS_RE') ||
      !contentSource.includes('обработка заняла') ||
      !contentSource.includes('interstitialReasoningFragment') ||
      !contentSource.includes('reasoningStatusCandidates')) {
    fail('content-chatgpt.js: missing interstitial reasoning capture adapter');
  }
  if (!contentSource.includes('reconcileNavigationCoverage') ||
      !contentSource.includes('reconciledInsertedCount') ||
      !contentSource.includes('повторный полный проход автоматически не запускается')) {
    fail('content-chatgpt.js: missing non-destructive navigation reconciliation');
  }
  if (contentSource.includes('coverageRetry') ||
      contentSource.includes('повторяю медленнее')) {
    fail('content-chatgpt.js: destructive automatic coverage retry must stay removed');
  }
  if (!contentSource.includes("mode === 'images'") ||
      !contentSource.includes('mergeRecoveredImagesIntoArchive') ||
      !contentSource.includes('lastRecoveredImageRefs')) {
    fail('content-chatgpt.js: missing image-only recovery mode');
  }
  if (!contentSource.includes('reasoningStatusLabelText') ||
      !contentSource.includes("text.startsWith(statusLabel)")) {
    fail('content-chatgpt.js: reasoning status stripping must not erase expanded reasoning');
  }
  if (!contentSource.includes('trimMessagesThroughBoundary') ||
      !contentSource.includes('captureBoundaryKey') ||
      !contentSource.includes("collect(map, order, settings, boundary)")) {
    fail('content-chatgpt.js: missing fixed bottom snapshot boundary');
  }
  if (!contentSource.includes("'resume-draft'") ||
      !contentSource.includes('allowDownwardFallback') ||
      !contentSource.includes('existingDraftId')) {
    fail('content-chatgpt.js: missing failed-capture draft recovery mode');
  }
  if (!serviceWorkerSource.includes('resumeFailedCaptureFromWorkingTab') ||
      !serviceWorkerSource.includes('ARCHIVER_RESUME_FAILED_CAPTURE') ||
      !serviceWorkerSource.includes('ARCHIVER_DELETE_DRAFT') ||
      !serviceWorkerSource.includes('ARCHIVER_DELETE_ARCHIVE')) {
    fail('service-worker.js: missing recovery/deletion commands');
  }
  if (!serviceWorkerSource.includes('inspectGoogleDocTabsAttached') ||
      !serviceWorkerSource.includes('expectedBeforeCount') ||
      !serviceWorkerSource.includes('verifiedTabCount !== sections.length')) {
    fail('service-worker.js: missing physical Google Docs tab-count verification');
  }
  if (!serviceWorkerSource.includes('ARCHIVER_PATCH_RECOVERED_IMAGES') ||
      !serviceWorkerSource.includes('DOC_IMAGE_PATCHES_KEY')) {
    fail('service-worker.js: missing recovered-image patch action');
  }
  if (!serviceWorkerSource.includes("type: 'ARCHIVER_PING'") ||
      !serviceWorkerSource.includes('ping.version !== expectedVersion') ||
      !contentSource.includes("message.type === 'ARCHIVER_PING'")) {
    fail('capture runtime: missing content-script version handshake');
  }
  console.log('OK: service-worker runtime helper declarations and reasoning adapter');
} catch (error) {
  fail(`service-worker.js runtime helper guard failed: ${error.message}`);
}

try {
  const popupHtml = await readFile('popup.html', 'utf8');
  const updaterVbs = await readFile('Update ChatGPT Archiver.vbs', 'utf8');
  if (!popupHtml.includes('id="updateExtension"') ||
      !popupHtml.includes('href="updater.html"') ||
      !popupHtml.includes('target="_blank"') ||
      popupHtml.includes('chatgpt-archiver:update')) {
    fail('popup.html: updater must use a direct new-tab link to updater.html');
  }
  if (!popupHtml.includes('id="reloadExtension"')) {
    fail('popup.html: missing extension reload action');
  }
  const updaterHtml = await readFile('updater.html', 'utf8');
  const updaterJs = await readFile('updater.js', 'utf8');
  if (!updaterHtml.includes('id="runUpdate"') || !updaterHtml.includes('id="log"')) {
    fail('updater.html: missing update controls or live log');
  }
  if (!updaterJs.includes('showDirectoryPicker') ||
      !updaterJs.includes("const REPO='Naeirae/ChatGPT-Conversation-Archiver'") ||
      !updaterJs.includes('api.github.com/repos/') ||
      !updaterJs.includes('raw.githubusercontent.com/')) {
    fail('updater.js: missing directory access or GitHub endpoints');
  }
  if (/powershell\.exe|shell\.Run|RegWrite/i.test(updaterVbs)) {
    fail('Update ChatGPT Archiver.vbs: legacy executable/protocol behavior must stay removed');
  }
  console.log('OK: in-browser updater integration');
} catch (error) {
  fail(`Updater UI/protocol guard failed: ${error.message}`);
}

try {
  const popupHtml = await readFile('popup.html', 'utf8');
  const popupJs = await readFile('popup.js', 'utf8');
  const requiredUiIds = [
    'status',
    'interfaceSettings',
    'interfacePalette',
    'interfaceFontPreset',
    'interfaceAccent',
    'interfaceBackground',
    'interfacePanel',
    'interfaceText',
    'settingsSaved'
  ];
  for (const id of requiredUiIds) {
    if (!popupHtml.includes('id="' + id + '"')) {
      fail('popup.html: missing UI control ' + id);
    }
  }
  if (popupHtml.indexOf('id="status"') > popupHtml.indexOf('id="interfaceSettings"')) {
    fail('popup.html: service status must stay above interface settings');
  }
  if (!popupHtml.includes('id="compareArchive"') ||
      !popupHtml.includes('id="continue"') ||
      popupHtml.includes('id="continue" class="hidden"')) {
    fail('popup.html: compare and continue must be separate visible actions');
  }
  if (!popupJs.includes('function applyInterfaceAppearance') ||
      !popupJs.includes('function normalizeInterfaceAppearance')) {
    fail('popup.js: missing interface appearance layer');
  }
  const iconSizes = new Map([
    ['icons/icon-16.png', 16],
    ['icons/icon-24.png', 24],
    ['icons/icon-32.png', 32],
    ['icons/icon-48.png', 48],
    ['icons/icon-64.png', 64],
    ['icons/icon-128.png', 128]
  ]);
  for (const [icon, expectedSize] of iconSizes) {
    await access(icon);
    const bytes = await readFile(icon);
    const pngSignature = [137,80,78,71,13,10,26,10];
    if (bytes.length < 24 || !pngSignature.every((value, index) => bytes[index] === value)) {
      fail(icon + ': invalid PNG signature');
      continue;
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== expectedSize || height !== expectedSize) {
      fail(icon + ': expected ' + expectedSize + 'x' + expectedSize + ', got ' + width + 'x' + height);
    }
  }
  console.log('OK: popup structure, appearance controls and PNG icon dimensions');
} catch (error) {
  fail(`Popup appearance guard failed: ${error.message}`);
}

try {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  if (manifest.manifest_version !== 3) {
    fail('manifest.json: manifest_version must be 3');
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) {
    fail('manifest.json: version must use x.y.z');
  }
  if (!Array.isArray(manifest.permissions)) {
    fail('manifest.json: permissions must be an array');
  }
  const requiredHosts = [
    'https://api.github.com/*',
    'https://raw.githubusercontent.com/*'
  ];
  for (const host of requiredHosts) {
    if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes(host)) {
      fail('manifest.json: missing updater host permission ' + host);
    }
  }
  console.log('OK: manifest.json', manifest.version);
} catch (error) {
  fail(`manifest.json: ${error.message}`);
}

try {
  const packageSource = await readFile('scripts/package.mjs', 'utf8');
  for (const requiredFile of ['updater.html', 'updater.css', 'updater.js']) {
    if (!packageSource.includes("'" + requiredFile + "'")) {
      fail('scripts/package.mjs: missing packaged updater file ' + requiredFile);
    }
  }
  console.log('OK: packaged updater files declared');
} catch (error) {
  fail('scripts/package.mjs updater guard failed: ' + error.message);
}

for (const path of forbiddenArtifacts) {
  try {
    await access(path);
    fail(`${path}: local runtime artifact must not be committed`);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail(`${path}: ${error.message}`);
  }
}

const tests = spawnSync(process.execPath, [
  '--test',
  'tests/text.test.mjs',
  'tests/urls.test.mjs',
  'tests/archive-store.test.mjs',
  'tests/google-docs-baseline.test.mjs',
  'tests/tab-plan.test.mjs'
], {
  encoding: 'utf8'
});
if (tests.status !== 0) {
  fail(`Regression tests failed\n${tests.stderr || tests.stdout}`);
} else {
  console.log(tests.stdout.trim());
}

if (failed) process.exit(1);
console.log('Repository verification passed.');
