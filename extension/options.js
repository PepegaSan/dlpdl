import { openClipDirectUi } from './lib/open-ui.js';
import { applyI18n, initI18n, t } from './lib/i18n.js';
import { resetServerProbe, serverReachable } from './lib/server-select.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/storage.js';

const fields = [
  'clipDirectBaseUrl',
  'fastServerUrl',
  'fastServerEnabled',
  'uiLocale',
  'saveTarget',
  'folder',
  'downloadType',
  'format',
  'clipEncodeMode',
  'postRender',
  'openUiAfterQueue',
  'keepPlayback',
  'apiToken',
];

const boolFields = new Set(['openUiAfterQueue', 'postRender', 'keepPlayback', 'fastServerEnabled']);

function withSlash(value) {
  const s = String(value || '').trim();
  return s && !s.endsWith('/') ? `${s}/` : s;
}

async function init() {
  const s = await loadSettings();
  await initI18n(s.uiLocale);
  applyI18n();
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    const val = s[key];
    if (el.tagName === 'SELECT') {
      el.value = String(val);
    } else {
      el.value = String(val ?? DEFAULT_SETTINGS[key] ?? '');
    }
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const patch = {};
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (boolFields.has(key)) {
      patch[key] = el.value === 'true';
    } else {
      patch[key] = el.value;
    }
  }
  const base = withSlash(patch.clipDirectBaseUrl);
  if (base) patch.clipDirectBaseUrl = base;
  patch.fastServerUrl = withSlash(patch.fastServerUrl);
  resetServerProbe();
  await saveSettings(patch);
  await initI18n(patch.uiLocale);
  applyI18n();
  const saved = document.getElementById('saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
});

document.getElementById('testFastServer')?.addEventListener('click', async () => {
  const result = document.getElementById('fastServerResult');
  const url = withSlash(document.getElementById('fastServerUrl')?.value);
  const token = document.getElementById('apiToken')?.value || '';
  result.textContent = '…';
  const ok = url ? await serverReachable(url, token) : false;
  result.textContent = t(ok ? 'options.fastServerOk' : 'options.fastServerFail');
  result.style.color = ok ? 'green' : '#b02a37';
});

document.getElementById('openUi')?.addEventListener('click', async () => {
  const s = await loadSettings();
  const urlEl = document.getElementById('clipDirectBaseUrl');
  const base = urlEl?.value?.trim() || s.clipDirectBaseUrl;
  await openClipDirectUi(base);
});

init();
