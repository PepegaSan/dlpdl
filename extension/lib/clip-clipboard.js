/**
 * Cross-hoster clip time transfer (copy / paste in popup).
 */

const CLIP_CLIPBOARD_KEY = 'clipDirectClipClipboard';

export function normalizeClipsForClipboard(clips) {
  return (clips || [])
    .filter((c) => c?.start && c?.end)
    .map((c) => ({
      start: String(c.start),
      end: String(c.end),
      includeInMerge: c.includeInMerge !== false,
    }));
}

export async function saveClipClipboard(clips, meta = {}) {
  const payload = {
    clips: normalizeClipsForClipboard(clips),
    fromHost: meta.fromHost || '',
    fromPage: meta.fromPage || '',
    ts: Date.now(),
  };
  await chrome.storage.local.set({ [CLIP_CLIPBOARD_KEY]: payload });
  return payload;
}

export async function loadClipClipboard() {
  const data = await chrome.storage.local.get(CLIP_CLIPBOARD_KEY);
  return data[CLIP_CLIPBOARD_KEY] || null;
}

export async function clearClipClipboard() {
  await chrome.storage.local.remove(CLIP_CLIPBOARD_KEY);
}
