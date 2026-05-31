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
    (s) => s?.url && (s.kind === 'hls' || /\.m3u8(\?|$|&)/i.test(s.url)),
  );
  return hls || streams.find((s) => s?.url) || null;
}
