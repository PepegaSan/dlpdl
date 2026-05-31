import { draftKeyForHref } from './page-url.js';

/** @typedef {object} ExtensionSettings
 * @property {string} clipDirectBaseUrl
 * @property {string} saveTarget browser | nas
 * @property {string} downloadType
 * @property {string} codec
 * @property {string} quality
 * @property {string} format
 * @property {string} folder
 * @property {string} customNamePrefix
 * @property {boolean} openUiAfterQueue
 */

export const DEFAULT_SETTINGS = {
  clipDirectBaseUrl: 'http://localhost:8090/',
  saveTarget: 'browser',
  downloadType: 'video',
  codec: 'auto',
  quality: 'best',
  format: 'any',
  folder: '',
  customNamePrefix: '',
  openUiAfterQueue: false,
};

export async function loadSettings() {
  const data = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...data };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

const CLIPS_KEY = 'clipDraftByUrl';

export function keyForPage(pageUrlOrKey) {
  if (pageUrlOrKey.startsWith('youtube:')) {
    return pageUrlOrKey;
  }
  return draftKeyForHref(pageUrlOrKey);
}

export async function loadAllClipDrafts() {
  const data = await chrome.storage.local.get(CLIPS_KEY);
  return data[CLIPS_KEY] || {};
}

export async function saveClipDraft(pageKey, clips) {
  const all = await loadAllClipDrafts();
  all[pageKey] = clips;
  await chrome.storage.local.set({ [CLIPS_KEY]: all });
}

export async function loadClipDraft(pageKey) {
  const all = await loadAllClipDrafts();
  return all[pageKey] ? [...all[pageKey]] : [];
}
