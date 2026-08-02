/**
 * Browser-like HTTP headers for sniffed CDN streams (turboviplay, emturbovid, …).
 */

import { isProgressiveCdnUrl } from './media-sniffer.js';

export const DEFAULT_STREAM_UA = (
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
);

const CDN_HOST_HINTS = [
  'turboviplay.com',
  'turbosplayer.com',
  'emturbovid.com',
  'cloudatacdn.com',
  'cloudatacdn.net',
  'dood.video',
  'doodstream.com',
];

function hostNeedsEmbedReferer(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return CDN_HOST_HINTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function normalizeReferer(referer) {
  if (!referer) return referer;
  try {
    const u = new URL(referer);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host.endsWith('.dood.video') || host === 'dood.video') {
      return `${u.protocol}//dood.video/`;
    }
    if (host.endsWith('.doodstream.com') || host === 'doodstream.com') {
      return `${u.protocol}//doodstream.com/`;
    }
    if (host.endsWith('.dood.watch') || host === 'dood.watch') {
      return `${u.protocol}//dood.watch/`;
    }
  } catch {
    /* ignore */
  }
  return referer;
}

function pickReferer(stream, pageUrl, tabUrl) {
  const candidates = [stream?.referer, stream?.origin, pageUrl, tabUrl].filter(Boolean);
  let picked = '';
  for (const ref of candidates) {
    try {
      const host = new URL(ref).hostname.toLowerCase();
      if (CDN_HOST_HINTS.some((h) => host.includes(h))) {
        picked = ref;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  if (!picked && stream?.url && (hostNeedsEmbedReferer(stream.url) || isProgressiveCdnUrl(stream.url))) {
    picked = pageUrl || tabUrl || candidates[0] || '';
  }
  if (!picked) {
    picked = candidates[0] || '';
  }
  return normalizeReferer(picked);
}

/** @returns {Record<string, string>} http_headers for ytdl_options_overrides */
export function httpHeadersForStream(stream, pageUrl, tabUrl, tabCookies = '') {
  const headers = {};
  const referer = pickReferer(stream, pageUrl, tabUrl);
  if (referer) {
    headers.Referer = normalizeReferer(referer);
    try {
      headers.Origin = new URL(headers.Referer).origin;
    } catch {
      /* ignore */
    }
  }
  headers['User-Agent'] = stream?.userAgent || DEFAULT_STREAM_UA;
  const cookie = stream?.cookie || tabCookies || '';
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

export function enrichStreamForQueue(stream, pageUrl, tabUrl) {
  if (!stream) {
    return stream;
  }
  const referer = pickReferer(stream, pageUrl, tabUrl);
  return {
    ...stream,
    referer,
    userAgent: stream.userAgent || DEFAULT_STREAM_UA,
  };
}
