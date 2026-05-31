/**
 * Classify media URLs captured from webRequest (clean-room).
 */

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
  // Obfuscated CDN / PHP wrappers (common on embed hosters and aggregator pages).
  if (
    full.includes('.m3u8')
    || full.includes('m3u8%2f')
    || full.includes('format=m3u8')
    || full.includes('type=m3u8')
    || /\/hls\//.test(pathname)
    || /\/manifest(\/|$|\?)/.test(pathname)
  ) {
    return 'hls';
  }
  if (pathname.endsWith('.m3u8') || full.includes('.m3u8?') || full.includes('.m3u8&')) {
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
  if (!streams?.length) {
    return null;
  }
  const hls = streams.find(
    (s) => s?.url && (s.kind === 'hls' || classifyMediaUrl(s.url) === 'hls'),
  );
  return hls || streams.find((s) => s?.url) || null;
}

/** Prefer HLS, then progressive file, then other sniffed media. */
export function preferBestStream(streams) {
  if (!streams?.length) {
    return null;
  }
  const order = ['hls', 'file', 'dash', 'hds', 'audio'];
  for (const kind of order) {
    const hit = streams.find((s) => s?.url && s.kind === kind);
    if (hit) {
      return hit;
    }
  }
  return streams.find((s) => s?.url) || null;
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

/**
 * True when the URL is a direct media resource for yt-dlp/ffmpeg — not a page shell
 * (.php player without manifest) that triggers "unusual extension php" errors.
 */
export function isUsableStreamUrl(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return false;
  }
  const kind = classifyMediaUrl(url);
  if (!kind) {
    return false;
  }
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (!path.endsWith('.php')) {
      return true;
    }
    const full = url.toLowerCase();
    if (kind === 'hls') {
      return (
        full.includes('.m3u8')
        || full.includes('m3u8%2f')
        || /\/hls\//.test(path)
        || /\/manifest/.test(path)
      );
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
