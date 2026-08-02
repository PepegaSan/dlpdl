/**
 * Classify media URLs captured from webRequest (clean-room).
 */

export const PROGRESSIVE_CDN_HOST_SUFFIXES = [
  'cloudatacdn.com',
  'cloudatacdn.net',
];

export function isProgressiveCdnUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROGRESSIVE_CDN_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

export const EMBED_SHELL_HOST_SUFFIXES = [
  'dood.video',
  'doodstream.com',
  'dood.watch',
  'emturbovid.com',
  'turboviplay.com',
];

export function isEmbedShellUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return EMBED_SHELL_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

/**
 * Script/control endpoints (e.g. remote_control.php, api.php) frequently carry
 * the same token/expiry params as media URLs — and sometimes even the media
 * file name as a query parameter — but they are NEVER the downloadable media
 * file. The real media is served by a separate request whose *path* ends in a
 * media extension. So any URL whose path ends in .php is treated as control.
 */
export function isControlScriptUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.php');
  } catch {
    return false;
  }
}

export function isSignedMediaUrl(url) {
  if (!url || isEmbedShellUrl(url) || isControlScriptUrl(url)) return false;
  try {
    const q = new URL(url).searchParams;
    return q.has('token') && (q.has('expiry') || q.has('expires'));
  } catch {
    return false;
  }
}

export function looksLikeDirectMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (isEmbedShellUrl(url) || isControlScriptUrl(url)) return false;
  const u = url.toLowerCase();
  if (u.startsWith('blob:') || u.startsWith('data:')) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  if (/\.(ts|m4s)(\?|$)/.test(u) && !u.includes('.m3u8')) return false;
  if (/\.m3u8|m3u8%2f|format=m3u8|type=m3u8/.test(u)) return true;
  if (/\.(mp4|webm|mkv|mov)(\?|$|&|\/|#)/.test(u)) return true;
  if (isProgressiveCdnUrl(url)) return true;
  if (isSignedMediaUrl(url)) return true;
  return false;
}

/** Stream URL safe to send to the download server (never an embed page). */
export function isDirectMediaStreamUrl(url) {
  if (!url || isEmbedShellUrl(url) || isControlScriptUrl(url)) return false;
  if (isHlsPlaylistUrl(url)) return true;
  return isUsableStreamUrl(url);
}

export function isHlsSegmentUrl(url) {
  if (!url) return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.m4s$/i.test(path)) {
      return true;
    }
    if (/\.ts$/i.test(path) || /\/seg[^/]*\.ts$/i.test(path)) {
      return true;
    }
    if (/\/\d+\.(ts|m4s)$/i.test(path)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** True for an HLS playlist/manifest — not a single .ts chunk. */
export function isHlsPlaylistUrl(url) {
  if (!url || isHlsSegmentUrl(url)) {
    return false;
  }
  const low = url.toLowerCase();
  return (
    /\.m3u8(\?|$|&)/i.test(low)
    || low.includes('m3u8%2f')
    || low.includes('format=m3u8')
    || low.includes('type=m3u8')
  );
}

/**
 * Many CDNs (e.g. phncdn) expose seg-NNN.ts in devtools; the playlist is sibling master.m3u8.
 */
export function guessPlaylistUrlFromSegment(segmentUrl) {
  if (!segmentUrl || !isHlsSegmentUrl(segmentUrl)) {
    return null;
  }
  try {
    const u = new URL(segmentUrl);
    const path = u.pathname;

    // turboviplay-style: /data1/HASH/HASH-00001.ts -> /data1/HASH/HASH.m3u8
    const turb = path.match(/^(.+\/([a-f0-9]{6,}))\/\2[-_]?(\d+)\.(ts|m4s)$/i);
    if (turb) {
      const trial = new URL(segmentUrl);
      trial.pathname = `${turb[1]}/${turb[2]}.m3u8`;
      return trial.toString();
    }

    // Sibling playlist: /path/foo-00001.ts -> /path/foo.m3u8
    const sibling = path.match(/^(.+\/)([a-z0-9_-]+)[-_]?\d+\.(ts|m4s)$/i);
    if (sibling) {
      const trial = new URL(segmentUrl);
      trial.pathname = `${sibling[1]}${sibling[2]}.m3u8`;
      return trial.toString();
    }

    // Generic fallback: same directory, master.m3u8
    // (Cannot probe index/playlist/manifest without network I/O here.)
    const base = path.replace(/\/[^/]*\.(ts|m4s)$/i, '');
    const trial = new URL(segmentUrl);
    trial.pathname = `${base}/master.m3u8`;
    return trial.toString();
  } catch {
    return null;
  }
}

export function classifyMediaUrl(url) {
  let pathname;
  let full;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname.toLowerCase();
    full = url.toLowerCase();
  } catch {
    return null;
  }

  if (isControlScriptUrl(url)) {
    return null;
  }

  if (isHlsSegmentUrl(url)) {
    return 'hls-segment';
  }

  if (isHlsPlaylistUrl(url)) {
    return 'hls';
  }

  if (isProgressiveCdnUrl(url) || isSignedMediaUrl(url)) {
    return 'file';
  }

  if (pathname.endsWith('.mpd') || full.includes('.mpd?')) {
    return 'dash';
  }
  if (pathname.endsWith('.f4m')) {
    return 'hds';
  }
  if (
    /\.(mp4|webm|mkv|mov)(\?|$|\/|#)/.test(pathname)
    || /\.(mp4|webm|mkv|mov)(\?|&|\/|#)/.test(full)
  ) {
    return 'file';
  }
  if (/\.(m4a|mp3|aac|ogg)(\?|$)/.test(pathname)) {
    return 'audio';
  }
  return null;
}

export function requestHeadersMap(requestHeaders) {
  const map = {};
  if (!Array.isArray(requestHeaders)) {
    return map;
  }
  for (const header of requestHeaders) {
    if (header?.name) {
      map[header.name.toLowerCase()] = header.value || '';
    }
  }
  return map;
}

export function preferHlsStream(streams) {
  return pickStreamForDownload(streams);
}

/** Prefer m3u8 playlist, then progressive file; infer playlist from .ts if needed. */
export function preferBestStream(streams) {
  return pickStreamForDownload(streams);
}

export function pickStreamForDownload(streams) {
  const list = streams || [];
  if (!list.length) {
    return null;
  }

  const playlists = list.filter((s) => s?.url && isHlsPlaylistUrl(s.url));
  if (playlists.length) {
    const order = ['hls'];
    for (const kind of order) {
      const hit = playlists.find((s) => s.kind === kind || isHlsPlaylistUrl(s.url));
      if (hit) return hit;
    }
    return playlists[0];
  }

  const files = list.filter(
    (s) => s?.url
      && classifyMediaUrl(s.url) === 'file'
      && !isEmbedShellUrl(s.url),
  );
  const progressive = files.find((s) => isProgressiveCdnUrl(s.url));
  if (progressive) return progressive;
  if (files.length) {
    return files[0];
  }

  const segment = list.find(
    (s) => s?.url && (s.kind === 'hls-segment' || isHlsSegmentUrl(s.url)),
  );
  if (segment) {
    const guessed = guessPlaylistUrlFromSegment(segment.url);
    if (guessed) {
      return {
        ...segment,
        url: guessed,
        kind: 'hls',
        inferredPlaylist: true,
      };
    }
  }

  return list.find((s) => s?.url && isDirectMediaStreamUrl(s.url)) || null;
}

export function isLikelyPageShellUrl(pageUrl) {
  if (!pageUrl) {
    return false;
  }
  try {
    const path = new URL(pageUrl).pathname.toLowerCase();
    return path.endsWith('.php') || path.endsWith('.html') || path.endsWith('.htm');
  } catch {
    return false;
  }
}

/** HLS-only embed players (no yt-dlp extractor) — queue must use sniffed stream. */
const HLS_EMBED_HOST_SUFFIXES = [
  'turboviplay.com',
  'emturbovid.com',
  'dood.video',
  'doodstream.com',
];

export function isHlsEmbedPageUrl(pageUrl) {
  if (!pageUrl) {
    return false;
  }
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase();
    return HLS_EMBED_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

/**
 * Sites whose player embeds video that yt-dlp's generic extractor cannot read
 * (e.g. "Unable to extract flashvars"). Queue must use the sniffed direct
 * stream instead of the page URL.
 */
const DIRECT_STREAM_PAGE_HOST_SUFFIXES = [
  'adultdeepfakes.com',
];

export function isDirectStreamPageUrl(pageUrl) {
  if (!pageUrl) {
    return false;
  }
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase();
    return DIRECT_STREAM_PAGE_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

export function needsSniffedStreamForPage(pageUrl) {
  return (
    isLikelyPageShellUrl(pageUrl)
    || isHlsEmbedPageUrl(pageUrl)
    || isDirectStreamPageUrl(pageUrl)
  );
}

export function isUsableStreamUrl(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return false;
  }
  if (isControlScriptUrl(url)) {
    return false;
  }
  if (isHlsSegmentUrl(url) && !isHlsPlaylistUrl(url)) {
    return false;
  }
  const kind = classifyMediaUrl(url);
  if (!kind || kind === 'hls-segment') {
    return false;
  }
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (!path.endsWith('.php')) {
      return true;
    }
    const full = url.toLowerCase();
    if (kind === 'hls') {
      return isHlsPlaylistUrl(url);
    }
    if (kind === 'file') {
      return /\.(mp4|webm|mkv|mov)/i.test(full)
        || isProgressiveCdnUrl(url)
        || isSignedMediaUrl(url);
    }
    return false;
  } catch {
    return false;
  }
}

export function usableStreams(streams) {
  return (streams || []).filter((s) => s?.url && isDirectMediaStreamUrl(s.url));
}
