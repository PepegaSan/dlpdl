import { draftKeyForHref } from './page-url.js';

/** @typedef {object} ExtensionSettings
 * @property {string} clipDirectBaseUrl
 * @property {string} saveTarget browser | nas
 * @property {string} downloadType
 * @property {string} codec
 * @property {string} quality
 * @property {string} format
 * @property {string} clipEncodeMode preserve | exact
 * @property {boolean} postRender re-encode after download (keyframe fix)
 * @property {string} folder
 * @property {string} customNamePrefix
 * @property {boolean} openUiAfterQueue
 * @property {boolean} keepPlayback keep CDN videos playing in background tabs
 * @property {string} uiLocale en | de
 * @property {string} apiToken optional CLIP_DIRECT_TOKEN of the backend
 * @property {string} fastServerUrl optional second instance on the PC (see lib/server-select.js)
 * @property {boolean} fastServerEnabled send jobs to fastServerUrl when it answers
 */

export const DEFAULT_SETTINGS = {
  clipDirectBaseUrl: 'http://localhost:8090/',
  fastServerUrl: 'http://localhost:8090/',
  fastServerEnabled: false,
  uiLocale: 'en',
  saveTarget: 'browser',
  downloadType: 'video',
  codec: 'auto',
  quality: 'best',
  format: 'any',
  clipEncodeMode: 'preserve',
  postRender: false,
  folder: '',
  customNamePrefix: '',
  openUiAfterQueue: false,
  keepPlayback: true,
  apiToken: '',
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
  if (clips?.length) {
    all[pageKey] = clips;
  } else {
    delete all[pageKey];
  }
  await chrome.storage.local.set({ [CLIPS_KEY]: all });
}

export async function loadClipDraft(pageKey) {
  const all = await loadAllClipDrafts();
  return all[pageKey] ? [...all[pageKey]] : [];
}
