/**
 * @param {string} baseUrl e.g. http://localhost:8090/
 */
export function apiUrl(baseUrl, path = 'api/jobs') {
  const base = baseUrl.replace(/\/+$/, '') + '/';
  const p = path.replace(/^\/+/, '');
  return new URL(p, base).toString();
}

/**
 * @param {import('./storage.js').ExtensionSettings} settings
 * @param {string} pageUrl
 * @param {{ start: string, end: string }[]} clips
 * @param {boolean} mergeClips
 */
export function buildJobBody(settings, pageUrl, clips, mergeClips) {
  const body = {
    url: pageUrl,
    download_type: settings.downloadType,
    format: settings.format === 'any' ? 'bestvideo*+bestaudio/best' : settings.format,
    custom_name_prefix: settings.customNamePrefix,
    save_target: settings.saveTarget || 'browser',
    folder: settings.saveTarget === 'nas' ? settings.folder : '',
    ytdl_options_overrides: '',
  };
  if (clips.length === 1 && !mergeClips) {
    body.clip_start = clips[0].start;
    body.clip_end = clips[0].end;
    return body;
  }
  return {
    ...body,
    clip_start: null,
    clip_end: null,
    merge_clips: mergeClips,
    clips: clips.map((c) => ({ start: c.start, end: c.end })),
  };
}

/**
 * @param {import('./storage.js').ExtensionSettings} settings
 * @param {{ url: string, referer?: string, origin?: string, userAgent?: string, kind?: string }} stream
 * @param {string|null} [pageUrl]
 * @param {{ start: string, end: string }[]} [clips]
 * @param {boolean} [mergeClips]
 */
export function buildStreamJobBody(settings, stream, pageUrl, clips = [], mergeClips = false) {
  const headers = {};
  const referer = stream.referer || stream.origin || pageUrl || '';
  if (referer) headers.Referer = referer;
  if (stream.userAgent) headers['User-Agent'] = stream.userAgent;
  const overrides = {};
  if (Object.keys(headers).length) overrides.http_headers = headers;

  const isHls = stream.kind === 'hls' || /\.m3u8(\?|$)/i.test(stream.url || '');
  if (isHls) {
    overrides.hls_use_mpegts = true;
    overrides.external_downloader = { m3u8: 'ffmpeg' };
  }

  const body = {
    url: stream.url,
    download_type: settings.downloadType,
    format: settings.format === 'any' ? 'bestvideo*+bestaudio/best' : settings.format,
    custom_name_prefix: settings.customNamePrefix,
    save_target: settings.saveTarget || 'browser',
    folder: settings.saveTarget === 'nas' ? settings.folder : '',
    ytdl_options_overrides: Object.keys(overrides).length ? JSON.stringify(overrides) : '',
  };

  const validClips = Array.isArray(clips) ? clips.filter((c) => c && c.start && c.end) : [];

  if (validClips.length === 0) {
    return body;
  }
  if (validClips.length === 1 && !mergeClips) {
    body.clip_start = validClips[0].start;
    body.clip_end = validClips[0].end;
    return body;
  }
  return {
    ...body,
    clip_start: null,
    clip_end: null,
    merge_clips: mergeClips,
    clips: validClips.map((c) => ({ start: c.start, end: c.end })),
  };
}
