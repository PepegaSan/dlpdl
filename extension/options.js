import { openClipDirectUi } from './lib/open-ui.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/storage.js';

const fields = [
  'clipDirectBaseUrl',
  'saveTarget',
  'folder',
  'downloadType',
  'format',
  'openUiAfterQueue',
];

async function init() {
  const s = await loadSettings();
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
