import { openClipDirectUi } from './lib/open-ui.js';
import { applyI18n, initI18n } from './lib/i18n.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/storage.js';

const fields = [
  'clipDirectBaseUrl',
  'uiLocale',
  'saveTarget',
  'folder',
  'downloadType',
  'format',
  'openUiAfterQueue',
];

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
    if (key === 'openUiAfterQueue') {
      patch[key] = el.value === 'true';
    } else {
      patch[key] = el.value;
    }
  }
  await saveSettings(patch);
  await initI18n(patch.uiLocale);
  applyI18n();
  const saved = document.getElementById('saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
});

document.getElementById('openUi')?.addEventListener('click', async () => {
  const s = await loadSettings();
  const urlEl = document.getElementById('clipDirectBaseUrl');
  const base = urlEl?.value?.trim() || s.clipDirectBaseUrl;
  await openClipDirectUi(base);
});

init();
