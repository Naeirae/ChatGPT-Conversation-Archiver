import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const jsFiles = [
  'service-worker.js',
  'content-chatgpt.js',
  'popup.js',
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
  console.log('OK: service-worker runtime helper declarations');
} catch (error) {
  fail(`service-worker.js runtime helper guard failed: ${error.message}`);
}

try {
  const popupHtml = await readFile('popup.html', 'utf8');
  const updaterVbs = await readFile('Update ChatGPT Archiver.vbs', 'utf8');
  if (!popupHtml.includes('id="updateExtension"') || popupHtml.includes('chatgpt-archiver:update')) {
    fail('popup.html: updater must open the in-browser updater page, not the legacy custom protocol');
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
      !updaterJs.includes('api.github.com/repos/Naeirae/ChatGPT-Conversation-Archiver') ||
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
  for (const icon of [
    'icons/icon-16.png',
    'icons/icon-24.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-64.png',
    'icons/icon-128.png'
  ]) {
    await access(icon);
  }
  console.log('OK: popup structure, appearance controls and icon assets');
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
  console.log('OK: manifest.json', manifest.version);
} catch (error) {
  fail(`manifest.json: ${error.message}`);
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
