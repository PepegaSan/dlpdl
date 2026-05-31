/**
 * Clip-Direct REST job payloads (clean-room).
 */

import { isHlsPlaylistUrl } from './media-sniffer.js';

export function jobsEndpoint(baseUrl, path = 'api/jobs') {
  const base = baseUrl.replace(/\/+$/, '') + '/';
  return new URL(path.replace(/^\/+/, ''), base).toString();
}

function baseFields(settings) {
  return {
    download_type: settings.downloadType,
    format: settings.format === 'any' ? 'bestvideo*+bestaudio/best' : settings.format,
    custom_name_prefix: settings.customNamePrefix,
    save_target: settings.saveTarget || 'browser',
    folder: settings.saveTarget === 'nas' ? settings.folder : '',
  };
}

function clipFields(clips, mergeClips) {
  if (clips.length === 1 && !mergeClips) {
    return { clip_start: clips[0].start, clip_end: clips[0].end };
  }
  return {
    clip_start: null,
    clip_end: null,
    merge_clips: mergeClips,
    clips: clips.map((c) => ({ start: c.start, end: c.end })),
  };
}

/** @param {import('./storage.js').ExtensionSettings} settings */
export function buildPageJobPayload(settings, pageUrl, clips, mergeClips) {
  const valid = clips.filter((c) => c?.start && c?.end);
  return {
    url: pageUrl,
    ytdl_options_overrides: '',
    ...baseFields(settings),
    ...clipFields(valid, mergeClips),
  };
}

function streamOverrides(stream, pageUrl) {
  const headers = {};
  const referer = stream.referer || stream.origin || pageUrl || '';
  if (referer) headers.Referer = referer;
  if (stream.userAgent) headers['User-Agent'] = stream.userAgent;
  const overrides = {};
  if (Object.keys(headers).length) {
    overrides.http_headers = headers;
  }
  const hls = isHlsPlaylistUrl(stream.url || '');
  if (hls) {
    overrides.hls_use_mpegts = true;
    overrides.external_downloader = { m3u8: 'ffmpeg' };
  }
  return overrides;
}

/** @param {import('./storage.js').ExtensionSettings} settings */
export function buildStreamJobPayload(
  settings,
  stream,
  pageUrl,
  clips = [],
  mergeClips = false,
) {
  const valid = clips.filter((c) => c?.start && c?.end);
  const overrides = streamOverrides(stream, pageUrl);
  const body = {
    url: stream.url,
    ytdl_options_overrides: Object.keys(overrides).length
      ? JSON.stringify(overrides)
      : '',
    ...baseFields(settings),
  };
  if (!valid.length) {
    return body;
  }
  return { ...body, ...clipFields(valid, mergeClips) };
}

/** Back-compat */
export const apiUrl = jobsEndpoint;
export const buildJobBody = buildPageJobPayload;
export const buildStreamJobBody = buildStreamJobPayload;
