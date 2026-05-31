/**
 * Stable keys and submission URLs for clip drafts (clean-room).
 */

function normalizeHost(hostname) {
  return hostname.replace(/^www\./, '').replace(/^m\./, '');
}

function youtubeVideoId(url) {
  const host = normalizeHost(url.hostname);
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id || null;
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    return url.searchParams.get('v');
  }
  return null;
}

/** @param {string} href */
export function draftKeyForHref(href) {
  try {
    const url = new URL(href);
    const ytId = youtubeVideoId(url);
    if (ytId) {
      return `youtube:${ytId}`;
    }
    url.hash = '';
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

/** @param {string} href */
export function submitUrlForHref(href) {
  try {
    const url = new URL(href);
    url.hash = '';
    const ytId = youtubeVideoId(url);
    if (ytId) {
      url.searchParams.delete('t');
      url.searchParams.delete('start');
    }
    return url.toString();
  } catch {
    return href;
  }
}

/** @deprecated alias */
export const normalizeStorageKey = draftKeyForHref;
/** @deprecated alias */
export const pageUrlForClipDirect = submitUrlForHref;
