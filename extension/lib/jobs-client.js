/**
 * Clip-Direct REST job payloads (clean-room).
 */

import { isHlsPlaylistUrl } from './media-sniffer.js';
import { httpHeadersForStream } from './stream-headers.js';

export function jobsEndpoint(baseUrl, path = 'api/jobs') {
  const base = baseUrl.replace(/\/+$/, '') + '/';
  return new URL(path.replace(/^\/+/, ''), base).toString();
}

export function clipHasTimes(c) {
  if (!c || typeof c !== 'object') return false;
  const { start, end } = c;
  if (start === null || start === undefined || start === '') return false;
  if (end === null || end === undefined || end === '') return false;
  return true;
}

/** Clips the user kept selected (checkbox on) and that have valid times. */
export function selectedClips(clips) {
  return (clips || []).filter((c) => clipHasTimes(c) && c.includeInMerge !== false);
}

/** Clips checked for merge (exclude includeInMerge === false). */
export function clipsForMerge(clips) {
  return selectedClips(clips);
}

function baseFields(settings) {
  const mode = settings.clipEncodeMode === 'exact' ? 'exact' : 'preserve';
  return {
    download_type: settings.downloadType,
    format: settings.format === 'any' ? 'bestvideo*+bestaudio/best' : settings.format,
    custom_name_prefix: settings.customNamePrefix,
    save_target: settings.saveTarget || 'browser',
    folder: settings.saveTarget === 'nas' ? settings.folder : '',
    clip_encode_mode: mode,
    post_render: settings.postRender === true,
  };
}

function clipFields(clips, mergeClips) {
  const mapped = clips.map((c) => ({ start: c.start, end: c.end }));
  const clip_count = clips.length;
  if (clips.length === 1 && !mergeClips) {
    return {
      clip_start: clips[0].start,
      clip_end: clips[0].end,
      clip_index: 1,
      clip_count,
      clips: mapped,
    };
  }
  return {
    clip_start: null,
    clip_end: null,
    merge_clips: mergeClips,
    clip_count,
    clips: mapped,
  };
}

/** @param {import('./storage.js').ExtensionSettings} settings */
export function buildPageJobPayload(settings, pageUrl, clips, mergeClips) {
  const valid = clips.filter(clipHasTimes);
  return {
    url: pageUrl,
    ytdl_options_overrides: '',
    ...baseFields(settings),
    ...clipFields(valid, mergeClips),
  };
}

function streamOverrides(stream, pageUrl, tabUrl, tabCookies = '') {
  const headers = httpHeadersForStream(stream, pageUrl, tabUrl, tabCookies);
  const overrides = { http_headers: headers };
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
  tabUrl = '',
  tabCookies = '',
) {
  const valid = clips.filter(clipHasTimes);
  const overrides = streamOverrides(stream, pageUrl, tabUrl, tabCookies);
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
