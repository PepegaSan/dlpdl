/**
 * Classify media URLs captured from webRequest (clean-room).
 */

export function isHlsSegmentUrl(url) {
  if (!url) return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\.ts$/i.test(path) || /\/seg[^/]*\.ts$/i.test(path);
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
    const base = u.pathname.replace(/\/[^/]*\.ts$/i, '');
    for (const name of ['master.m3u8', 'index.m3u8', 'playlist.m3u8', 'manifest.m3u8']) {
      const trial = new URL(segmentUrl);
      trial.pathname = `${base}/${name}`;
      return trial.toString();
    }
  } catch {
    return null;
  }
  return null;
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

  if (isHlsSegmentUrl(url)) {
    return 'hls-segment';
  }

  if (isHlsPlaylistUrl(url)) {
    return 'hls';
  }

  if (pathname.endsWith('.mpd') || full.includes('.mpd?')) {
    return 'dash';
  }
  if (pathname.endsWith('.f4m')) {
    return 'hds';
  }
  if (
    /\.(mp4|webm|mkv|mov)(\?|$)/.test(pathname)
    || /\.(mp4|webm|mkv|mov)(\?|&)/.test(full)
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

  const files = list.filter((s) => s?.url && classifyMediaUrl(s.url) === 'file');
  if (files.length) {
    return files[0];
  }

  const segment = list.find((s) => s?.url && (s.kind === 'hls-segment' || isHlsSegmentUrl(s.url)));
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

  return list.find((s) => s?.url && isUsableStreamUrl(s.url)) || null;
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

export function isUsableStreamUrl(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
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
      return /\.(mp4|webm|mkv|mov)/i.test(full);
    }
    return false;
  } catch {
    return false;
  }
}

export function usableStreams(streams) {
  return (streams || []).filter((s) => s?.url && isUsableStreamUrl(s.url));
}
