/**
 * @param {string} [baseUrl] e.g. http://localhost:8090/ or http://localhost:8085/
 * @returns {string}
 */
export function normalizeClipDirectBase(baseUrl) {
  const s = String(baseUrl || '').trim();
  if (!s) return 'http://localhost:8090/';
  return s.endsWith('/') ? s : `${s}/`;
}

/** Full Web-UI URL (jobs list + PC download). */
export function clipDirectUiUrl(baseUrl) {
  return normalizeClipDirectBase(baseUrl);
}

/**
 * Focus an existing tab for this Clip-Direct host or open a new one.
 * @param {string} baseUrl
 */
export async function openClipDirectUi(baseUrl, opts = {}) {
  const uiUrl = clipDirectUiUrl(baseUrl);
  const originPrefix = uiUrl.replace(/\/+$/, '');
  const background = opts.background === true;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(
    (t) => typeof t.url === 'string' && t.url.startsWith(originPrefix),
  );
  if (existing?.id != null) {
    if (!background) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
    }
    return { reused: true, url: uiUrl };
  }
  await chrome.tabs.create({ url: uiUrl, active: !background });
  return { reused: false, url: uiUrl };
}
