import {
  buildPageJobPayload,
  buildStreamJobPayload,
  clipsForMerge,
  jobsEndpoint,
  selectedClips,
} from './lib/jobs-client.js';
import {
  classifyMediaUrl,
  guessPlaylistUrlFromSegment,
  isHlsPlaylistUrl,
  isHlsSegmentUrl,
  isDirectMediaStreamUrl,
  isEmbedShellUrl,
  isHlsEmbedPageUrl,
  isProgressiveCdnUrl,
  isSignedMediaUrl,
  isLikelyPageShellUrl,
  isUsableStreamUrl,
  isTokenizedHlsCdnUrl,
  needsSniffedStreamForPage,
  preferBestStream,
  requestHeadersMap,
  usableStreams,
} from './lib/media-sniffer.js';
import { parseClockTime } from './lib/format-time.js';
import { downloadHlsWindows } from './lib/hls-browser-fetch.js';
import { clearStreamFetchHeaders, setStreamFetchHeaders } from './lib/dnr-headers.js';
import { loadClipClipboard, saveClipClipboard } from './lib/clip-clipboard.js';
import { openClipDirectUi } from './lib/open-ui.js';
import { collectStreamCookies, mergeCookieHeader } from './lib/browser-cookies.js';
import { enrichStreamForQueue, httpHeadersForStream } from './lib/stream-headers.js';
import { loadSettings } from './lib/storage.js';
import { TabSessionStore } from './lib/tab-session.js';

const BADGE_COLOR = '#22c55e';
const session = new TabSessionStore();
let lastMediaTabId = null;

try {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
} catch {
  /* ignore */
}

function updateBadge(tabId) {
  if (tabId == null || tabId < 0) return;
  const count = session.streams(tabId).length;
  try {
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
  } catch {
    /* ignore */
  }
}

function recordDetectedUrl(tabId, url, meta) {
  let kind = classifyMediaUrl(url);
  if (!kind && isHlsSegmentUrl(url)) {
    kind = 'hls-segment';
  }
  if (!kind) return;
  if (kind === 'hls-segment') {
    session.rememberHlsSegment(tabId, url);
    return;
  }
  session.addStream(tabId, { url, kind, ...meta });
  lastMediaTabId = tabId;
  updateBadge(tabId);
}

function shouldRememberCookies(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/turboviplay|turbosplayer|emturbovid|cloudatacdn|dood\.video|doodstream|tnmr\.org/.test(host)) {
      return true;
    }
  } catch {
    return false;
  }
  return Boolean(
    classifyMediaUrl(url)
    || isHlsSegmentUrl(url)
    || isHlsPlaylistUrl(url)
    || isSignedMediaUrl(url)
    || isTokenizedHlsCdnUrl(url)
  );
}

function rememberTabCookies(tabId, url, cookieHeader) {
  if (!cookieHeader || tabId == null || tabId < 0) return;
  if (shouldRememberCookies(url)) {
    session.rememberRequestCookies(tabId, cookieHeader);
  }
}

function onBeforeSendHeaders(details) {
  const { tabId, url, requestHeaders, type } = details;
  if (tabId == null || tabId < 0) return;
  const headers = requestHeadersMap(requestHeaders);
  rememberTabCookies(tabId, url, headers.cookie || '');
  recordDetectedUrl(tabId, url, {
    type: type || '',
    referer: headers.referer || headers.origin || '',
    origin: headers.origin || '',
    userAgent: headers['user-agent'] || '',
    cookie: headers.cookie || '',
    ts: Date.now(),
  });
}

function onCompleted(details) {
  const { tabId, url, type, initiator, documentUrl } = details;
  if (tabId == null || tabId < 0) return;
  const referer = initiator || documentUrl || '';
  let origin = '';
  if (referer) {
    try {
      origin = new URL(referer).origin;
    } catch {
      /* ignore */
    }
  }
  recordDetectedUrl(tabId, url, {
    type: type || '',
    referer,
    origin,
    userAgent: '',
    ts: Date.now(),
  });
}

function normalizeStreamForQueue(stream) {
  if (!stream?.url) return stream;
  if (isHlsPlaylistUrl(stream.url)) {
    return { ...stream, kind: 'hls' };
  }
  if (isProgressiveCdnUrl(stream.url) || isSignedMediaUrl(stream.url)) {
    return { ...stream, kind: 'file' };
  }
  if (isHlsSegmentUrl(stream.url)) {
    const guessed = guessPlaylistUrlFromSegment(stream.url);
    if (guessed) {
      return { ...stream, url: guessed, kind: 'hls', inferredPlaylist: true };
    }
  }
  return stream;
}

function streamsForTab(tabId) {
  const usable = usableStreams(session.streams(tabId));
  if (usable.length) return usable;
  const seg = session.lastHlsSegmentUrl(tabId);
  const guessed = seg ? guessPlaylistUrlFromSegment(seg) : null;
  if (!guessed) return session.streams(tabId);
  return [
    {
      url: guessed,
      kind: 'hls',
      inferredPlaylist: true,
      referer: '',
      origin: '',
      userAgent: '',
      ts: Date.now(),
    },
  ];
}

try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        onBeforeSendHeaders(details);
      } catch {
        /* never break the request */
      }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders'],
  );
} catch (err) {
  console.error('Clip-Direct: sniffer registration failed', err);
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    try {
      onCompleted(details);
    } catch {
      /* ignore */
    }
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === 'main_frame' && details.tabId >= 0) {
      session.clearTab(details.tabId);
      updateBadge(details.tabId);
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  session.clearTab(tabId);
});

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function jobBodyWithTabMeta(body, tabId) {
  const enriched = { ...body };
  const id = tabId ?? (await activeTabId());
  if (id != null) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.title) {
        enriched.page_title = tab.title;
      }
    } catch {
      /* ignore */
    }
  }
  return enriched;
}

async function postJob(settings, body, tabId) {
  const url = jobsEndpoint(settings.clipDirectBaseUrl);
  const payload = await jobBodyWithTabMeta(body, tabId);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text || res.statusText };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: { raw: text } };
  }
}

async function maybeOpenUi(settings, opts = {}) {
  if (!settings.openUiAfterQueue) return;
  try {
    await openClipDirectUi(settings.clipDirectBaseUrl, opts);
  } catch {
    /* ignore */
  }
}

function isClipDirectUiUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.port === '8090') return true;
    return /localhost|127\.0\.0\.1/i.test(u.hostname) && /clip-direct|8090/.test(url);
  } catch {
    return false;
  }
}

async function tabIdForQueue(hintId, streamUrl) {
  if (hintId != null && hintId >= 0) {
    return hintId;
  }
  const active = await activeTabId();
  if (active != null) {
    const owned = session.streams(active);
    if (streamUrl && owned.some((s) => s.url === streamUrl)) {
      return active;
    }
    try {
      const tab = await chrome.tabs.get(active);
      if (!isClipDirectUiUrl(tab.url || '')) {
        return active;
      }
    } catch {
      return active;
    }
  }
  if (lastMediaTabId != null && session.streams(lastMediaTabId).length) {
    return lastMediaTabId;
  }
  if (streamUrl) {
    for (const [id, list] of Object.entries(session.streamsByTab || {})) {
      if ((list || []).some((s) => s.url === streamUrl)) {
        return Number(id);
      }
    }
  }
  return active;
}

function shouldBrowserFetch(url) {
  if (!url) return false;
  if (isTokenizedHlsCdnUrl(url)) return true;
  try {
    return new URL(url).hostname.toLowerCase().endsWith('tnmr.org');
  } catch {
    return false;
  }
}

function clipWindows(clips, mergeClips) {
  const valid = mergeClips ? clipsForMerge(clips) : selectedClips(clips);
  return valid.map((c) => ({
    start: parseClockTime(c.start),
    end: parseClockTime(c.end),
  })).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
}

async function postJobProgress(settings, jobId, msg, progress) {
  try {
    await fetch(jobsEndpoint(settings.clipDirectBaseUrl, `api/jobs/${jobId}/progress`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg, progress }),
    });
  } catch {
    /* ignore */
  }
}

async function failBrowserJob(settings, jobId, error) {
  try {
    await fetch(jobsEndpoint(settings.clipDirectBaseUrl, `api/jobs/${jobId}/fail`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    });
  } catch {
    /* ignore */
  }
}

async function ingestBrowserJob(settings, jobId, bytes, timelineStart, parts) {
  const url = new URL(jobsEndpoint(settings.clipDirectBaseUrl, `api/jobs/${jobId}/ingest`));
  if (Number.isFinite(timelineStart)) {
    url.searchParams.set('timeline_start', String(timelineStart));
  }
  if (Array.isArray(parts) && parts.length > 1) {
    url.searchParams.set(
      'parts',
      parts.map((p) => `${p.timelineStart}:${p.bytes.byteLength}`).join(';'),
    );
  }
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text || res.statusText };
  }
  return { ok: true };
}

async function queueStreamBrowser(stream, pageUrl, tabUrl, clips, mergeClips, tabId, mergedCookies) {
  const settings = await loadSettings();
  const headers = httpHeadersForStream(stream, pageUrl, tabUrl, mergedCookies);
  const body = buildStreamJobPayload(
    settings,
    stream,
    pageUrl,
    Array.isArray(clips) ? clips : [],
    !!mergeClips,
    tabUrl,
    mergedCookies,
    true,
  );
  const created = await postJob(settings, body, tabId);
  if (!created.ok) return created;
  const jobId = created.data?.id || created.data?.ids?.[0];
  if (!jobId) {
    return { ok: false, error: 'no job id' };
  }
  await maybeOpenUi(settings, { background: true });
  try {
    await setStreamFetchHeaders(stream.url, headers);
    const windows = clipWindows(clips, mergeClips);
    const downloaded = await downloadHlsWindows(
      stream.url,
      mergeClips || windows.length <= 1 ? windows : windows.slice(0, 1),
      (frac, msg) => {
        void postJobProgress(settings, jobId, msg, frac);
      },
    );
    const exactCut = settings.clipEncodeMode === 'exact';
    await postJobProgress(
      settings,
      jobId,
      exactCut ? 'Exakter Schnitt…' : (settings.postRender ? 'Neu rendern (Keyframe-Fix)…' : 'Remux…'),
      0.91,
    );
    const ingested = await ingestBrowserJob(
      settings,
      jobId,
      downloaded.bytes,
      downloaded.timelineStart,
      downloaded.parts,
    );
    if (!ingested.ok) {
      await failBrowserJob(settings, jobId, ingested.error || 'ingest failed');
      return { ok: false, error: ingested.error };
    }
    return created;
  } catch (err) {
    const detail = err?.message || String(err);
    await failBrowserJob(settings, jobId, `Browser download failed: ${detail}`);
    return { ok: false, error: detail };
  } finally {
    await clearStreamFetchHeaders();
  }
}

async function queueStream(stream, pageUrl, clips, mergeClips, tabHint = null) {
  if (!stream?.url) {
    return { ok: false, error: 'no_stream' };
  }
  const tabId = await tabIdForQueue(tabHint, stream.url);
  let tabUrl = pageUrl || '';
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url || tabUrl;
    } catch {
      /* ignore */
    }
  }
  if (isClipDirectUiUrl(tabUrl)) {
    tabUrl = pageUrl || tabUrl;
  }
  const tabCookies = tabId != null ? session.cookieHeader(tabId) : '';
  let mergedCookies = mergeCookieHeader(stream.cookie, tabCookies);
  try {
    const apiCookies = await collectStreamCookies(stream.url, pageUrl, tabUrl);
    mergedCookies = mergeCookieHeader(stream.cookie, tabCookies, apiCookies);
  } catch (err) {
    console.warn('Clip-Direct: cookie collection failed, sending without API cookies', err);
  }
  if (mergedCookies && tabId != null) {
    session.rememberRequestCookies(tabId, mergedCookies);
  }
  const enriched = normalizeStreamForQueue(
    enrichStreamForQueue(
      { ...stream, cookie: mergedCookies },
      pageUrl,
      tabUrl,
    ),
  );
  if (!isDirectMediaStreamUrl(enriched.url)) {
    return {
      ok: false,
      errorKey: isEmbedShellUrl(enriched.url) ? 'error.embedShellNotStream' : 'error.hlsSegmentOnly',
    };
  }
  if (isTokenizedHlsCdnUrl(enriched.url)) {
    let refererHost = '';
    let streamHost = '';
    try {
      refererHost = new URL(enriched.referer || pageUrl || tabUrl || '').hostname.toLowerCase();
      streamHost = new URL(enriched.url).hostname.toLowerCase();
    } catch {
      refererHost = '';
    }
    const related = refererHost
      && streamHost
      && (refererHost === streamHost
        || refererHost.endsWith(`.${streamHost}`)
        || streamHost.endsWith(`.${refererHost}`));
    if (!refererHost || related) {
      return { ok: false, errorKey: 'error.needOriginalPage' };
    }
  }
  const list = Array.isArray(clips) ? clips : [];
  if (shouldBrowserFetch(enriched.url)) {
    const valid = mergeClips ? clipsForMerge(list) : selectedClips(list);
    if (!mergeClips && valid.length > 1) {
      let last = { ok: true };
      for (const clip of valid) {
        last = await queueStreamBrowser(
          enriched, pageUrl, tabUrl, [clip], false, tabId, mergedCookies,
        );
        if (!last.ok) return last;
      }
      return last;
    }
    return queueStreamBrowser(
      enriched, pageUrl, tabUrl, valid, !!mergeClips, tabId, mergedCookies,
    );
  }
  const settings = await loadSettings();
  const body = buildStreamJobPayload(
    settings,
    enriched,
    pageUrl,
    list,
    !!mergeClips,
    tabUrl,
    mergedCookies,
  );
  const result = await postJob(settings, body, tabId);
  if (result.ok) await maybeOpenUi(settings);
  return result;
}

async function buildStreamFromVideoUrl(url, tabId, pageUrl) {
  let referer = pageUrl || '';
  try {
    const tab = await chrome.tabs.get(tabId);
    referer = tab.url || pageUrl || referer;
  } catch {
    /* ignore */
  }
  return {
    url,
    kind: classifyMediaUrl(url) || 'file',
    referer,
    origin: '',
    userAgent: '',
    ts: Date.now(),
  };
}

async function streamFromActiveVideo(tabId, pageUrl) {
  if (tabId == null || tabId < 0) {
    return null;
  }

  const pickUrl = (url) => (url && isDirectMediaStreamUrl(url) ? url : null);

  const res = await forwardToTab(tabId, { action: 'getVideoMediaUrl' });
  const fromMessage = pickUrl(res?.ok ? res.url : null);
  if (fromMessage) {
    return buildStreamFromVideoUrl(fromMessage, tabId, pageUrl);
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        function candidateUrls(video) {
          const urls = [];
          const push = (u) => {
            if (u && typeof u === 'string') urls.push(u);
          };
          push(video.currentSrc);
          push(video.src);
          for (const s of video.querySelectorAll('source')) push(s.src);
          push(video.getAttribute('data-src'));
          push(video.getAttribute('data-url'));
          return urls.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:'));
        }
        function looksLikeMedia(u) {
          if (!u || typeof u !== 'string') return false;
          try {
            const host = new URL(u).hostname.toLowerCase();
            if (/dood\.video|doodstream|emturbovid|turboviplay/.test(host)) return false;
          } catch { return false; }
          const l = u.toLowerCase();
          if (l.startsWith('blob:') || l.startsWith('data:')) return false;
          if (/\.(ts|m4s)(\?|$)/.test(l) && !l.includes('.m3u8')) return false;
          if (/\.m3u8|m3u8%2f|\.mp4|\.webm|cloudatacdn\.com/.test(l)) return true;
          try {
            const parsed = new URL(u);
            // Skip script/control endpoints (e.g. remote_control.php): the real
            // media is a separate request whose path ends in a media extension.
            if (parsed.pathname.toLowerCase().endsWith('.php')) return false;
            const q = parsed.searchParams;
            if (q.has('token') && (q.has('expiry') || q.has('expires'))) return true;
          } catch { /* ignore */ }
          return false;
        }
        function findM3u8InPage() {
          const found = [];
          const re = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
          const html = document.documentElement?.innerHTML || '';
          let m;
          while ((m = re.exec(html)) !== null) {
            found.push(m[0].replace(/\\/g, ''));
          }
          return found.find(looksLikeMedia) || null;
        }
        const videos = Array.from(document.querySelectorAll('video'));
        let best = null;
        let bestArea = 0;
        for (const video of videos) {
          let area = 0;
          try {
            area = video.clientWidth * video.clientHeight;
          } catch {
            /* ignore */
          }
          if (area < bestArea) continue;
          const urls = candidateUrls(video);
          const media = urls.find(looksLikeMedia);
          if (media) {
            best = media;
            bestArea = area;
          }
        }
        return best || findM3u8InPage();
      },
    });
    for (const row of results || []) {
      const url = pickUrl(row?.result);
      if (url) {
        return buildStreamFromVideoUrl(url, tabId, pageUrl);
      }
    }
  } catch {
    /* scripting blocked on some pages */
  }

  return null;
}

async function pickStreamForShellPage(tabId, pageUrl) {
  const fromVideo = await streamFromActiveVideo(tabId, pageUrl);
  if (fromVideo?.url && isDirectMediaStreamUrl(fromVideo.url)) {
    return normalizeStreamForQueue(fromVideo);
  }

  let sniffed = preferBestStream(session.streams(tabId));
  if (sniffed?.url && !isDirectMediaStreamUrl(sniffed.url)) {
    sniffed = null;
  }
  if (!sniffed?.url) {
    const seg = session.lastHlsSegmentUrl(tabId);
    const guessed = seg ? guessPlaylistUrlFromSegment(seg) : null;
    if (guessed) {
      sniffed = {
        url: guessed,
        kind: 'hls',
        referer: pageUrl || '',
        inferredPlaylist: true,
        ts: Date.now(),
      };
    }
  }
  if (sniffed?.url) {
    return normalizeStreamForQueue(sniffed);
  }
  if (fromVideo?.url && isDirectMediaStreamUrl(fromVideo.url)) {
    return normalizeStreamForQueue(fromVideo);
  }
  return null;
}

async function queueClips(pageUrl, clips, mergeClips, tabHint = null) {
  if (!clips?.length) {
    return { ok: false, error: 'no_clips' };
  }
  const settings = await loadSettings();
  const tabId = await tabIdForQueue(tabHint);

  // MeTube behaviour: page URL for sites with yt-dlp extractors (YouTube, Vimeo, …).
  // Shell .php pages and HLS-only embeds (turboviplay, emturbovid) need a sniffed stream.
  if (!needsSniffedStreamForPage(pageUrl)) {
    const body = buildPageJobPayload(settings, pageUrl, clips, !!mergeClips);
    const result = await postJob(settings, body, tabId);
    if (result.ok) await maybeOpenUi(settings);
    return result;
  }

  const stream = await pickStreamForShellPage(tabId, pageUrl);
  if (stream?.url && isDirectMediaStreamUrl(stream.url)) {
    return queueStream(stream, pageUrl, clips, mergeClips, tabId);
  }

  return {
    ok: false,
    errorKey: isHlsEmbedPageUrl(pageUrl) ? 'error.hlsEmbedNoStream' : 'error.shellPagePhp',
  };
}

async function queueFromPage(pageUrl, tabHint) {
  const tabId = await tabIdForQueue(tabHint);
  let resolvedPage = pageUrl || '';
  if (!resolvedPage && tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolvedPage = tab.url || '';
    } catch {
      /* ignore */
    }
  }
  const clips = session.clipEntry(tabId)?.clips || [];
  const valid = selectedClips(clips);

  // Same split as popup Queue: YouTube & Co. use the page URL; embed/CDN
  // pages must use the sniffed stream.
  if (!needsSniffedStreamForPage(resolvedPage)) {
    if (valid.length) {
      return queueClips(resolvedPage, valid, false, tabId);
    }
    const settings = await loadSettings();
    const body = buildPageJobPayload(settings, resolvedPage, [], false);
    const result = await postJob(settings, body, tabId);
    if (result.ok) await maybeOpenUi(settings);
    return result;
  }

  const stream = await pickStreamForShellPage(tabId, resolvedPage);
  if (stream?.url && isDirectMediaStreamUrl(stream.url)) {
    return queueStream(stream, resolvedPage, valid, false, tabId);
  }
  if (valid.length) {
    return queueClips(resolvedPage, valid, false, tabId);
  }
  return {
    ok: false,
    errorKey: isHlsEmbedPageUrl(resolvedPage) ? 'error.hlsEmbedNoStream' : 'error.shellPagePhp',
  };
}

async function sendToAllFrames(tabId, payload) {
  let frameIds = [0];
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    const ids = (injected || []).map((row) => row.frameId).filter((id) => id != null);
    if (ids.length) frameIds = ids;
  } catch {
    /* chrome:// or no scripting — fall back to top frame */
  }
  const results = await Promise.all(frameIds.map(async (frameId) => {
    try {
      return await chrome.tabs.sendMessage(tabId, payload, { frameId });
    } catch {
      return null;
    }
  }));
  return results.find((r) => r?.ok) || null;
}

function keepIncludeFlags(incoming, existing) {
  if (!Array.isArray(incoming) || !existing?.length) return incoming;
  return incoming.map((clip, index) => {
    const prev = existing.find((p) => p.start === clip.start && p.end === clip.end)
      || existing[index];
    if (!prev || prev.start !== clip.start || prev.end !== clip.end) {
      return clip;
    }
    return { ...clip, includeInMerge: prev.includeInMerge !== false };
  });
}

async function forwardToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('Receiving end does not exist')) {
      return { ok: false, error: 'no_content_script', hint: 'reload_tab' };
    }
    return { ok: false, error: msg };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'queueClips') {
    queueClips(msg.pageUrl, msg.clips, msg.mergeClips, sender?.tab?.id ?? msg.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.action === 'queueStream') {
    queueStream(msg.stream, msg.pageUrl, msg.clips, msg.mergeClips, sender?.tab?.id ?? msg.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.action === 'queueFromPage') {
    queueFromPage(msg.pageUrl, sender?.tab?.id ?? msg.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.action === 'reportClips') {
    const tabId = sender?.tab?.id;
    if (tabId != null && tabId >= 0) {
      const clips = Array.isArray(msg.clips) ? msg.clips : [];
      const existing = session.clipEntry(tabId);
      if (!clips.length) {
        if (
          existing?.clips?.length
          && existing.pageKey
          && msg.pageKey
          && msg.pageKey !== existing.pageKey
        ) {
          sendResponse({ ok: true });
          return true;
        }
        if (!existing?.clips?.length) {
          sendResponse({ ok: true });
          return true;
        }
        if (existing.pageKey && msg.pageKey && existing.pageKey !== msg.pageKey) {
          sendResponse({ ok: true });
          return true;
        }
      }
      const merged = keepIncludeFlags(clips, existing?.clips);
      session.setClips(tabId, merged, msg.pageUrl, msg.pageKey);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.action === 'getTabClips') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      sendResponse({ ok: true, tabClips: session.clipEntry(tabId) });
    })();
    return true;
  }

  if (msg?.action === 'removeTabClip') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      const entry = session.clipEntry(tabId);
      const pageKey = msg.pageKey || entry?.pageKey || '';
      let result = { ok: false, error: 'no_clips', clips: [] };

      if (tabId != null) {
        try {
          result = await chrome.tabs.sendMessage(tabId, {
            action: 'removeClip',
            pageKey: pageKey || undefined,
            index: Number(msg.index),
          });
        } catch {
          result = { ok: false, error: 'no_content_script' };
        }
      }

      if (!result?.ok && tabId != null) {
        const fallback = session.removeClipAt(tabId, Number(msg.index));
        if (fallback.ok) {
          try {
            await chrome.tabs.sendMessage(tabId, {
              action: 'replaceClips',
              pageKey: fallback.pageKey || pageKey || undefined,
              clips: fallback.clips,
            });
          } catch {
            /* storage sync best-effort */
          }
          result = fallback;
        }
      }

      if (result?.ok && tabId != null) {
        session.setClips(
          tabId,
          result.clips,
          entry?.pageUrl || '',
          result.pageKey || pageKey,
        );
      }
      sendResponse(result);
    })();
    return true;
  }

  if (msg?.action === 'setClipMergeIncluded') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      if (tabId == null || tabId < 0) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      const fromSession = session.setClipMergeIncluded(
        tabId,
        Number(msg.index),
        msg.includeInMerge,
      );
      try {
        await sendToAllFrames(tabId, {
          action: 'setClipMergeIncluded',
          pageKey: msg.pageKey || fromSession.pageKey || undefined,
          index: Number(msg.index),
          includeInMerge: msg.includeInMerge,
        });
      } catch {
        /* session is source of truth */
      }
      const latest = session.clipEntry(tabId);
      sendResponse({
        ok: fromSession.ok || Boolean(latest?.clips?.length),
        clips: latest?.clips || fromSession.clips || [],
        pageKey: latest?.pageKey || fromSession.pageKey || '',
        error: fromSession.ok ? undefined : fromSession.error,
      });
    })();
    return true;
  }

  if (msg?.action === 'updateTabClipTimes') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      const payload = {
        action: 'updateClipTimes',
        pageKey: msg.pageKey,
        index: Number(msg.index),
        start: msg.start,
        end: msg.end,
      };
      let result = await sendToAllFrames(tabId, payload);
      if (!result?.ok) {
        result = session.setClipTimesAt(tabId, Number(msg.index), msg.start, msg.end);
        if (result?.ok) {
          try {
            await sendToAllFrames(tabId, {
              action: 'replaceClips',
              pageKey: result.pageKey || msg.pageKey || undefined,
              clips: result.clips,
            });
          } catch {
            /* session is source of truth for the next send */
          }
        }
      }
      if (result?.ok && Array.isArray(result.clips)) {
        const entry = session.clipEntry(tabId);
        session.setClips(
          tabId,
          result.clips,
          entry?.pageUrl || '',
          result.pageKey || entry?.pageKey || '',
        );
      }
      sendResponse(result || { ok: false, error: 'no_owner' });
    })();
    return true;
  }

  if (msg?.action === 'getClipClipboard') {
    (async () => {
      const clipboard = await loadClipClipboard();
      sendResponse({ ok: true, clipboard });
    })();
    return true;
  }

  if (msg?.action === 'copyClipsToClipboard') {
    (async () => {
      const clips = Array.isArray(msg.clips) ? msg.clips : [];
      if (!clips.length) {
        sendResponse({ ok: false, error: 'no_clips' });
        return;
      }
      const clipboard = await saveClipClipboard(clips, msg.meta || {});
      sendResponse({ ok: true, clipboard });
    })();
    return true;
  }

  if (msg?.action === 'importTabClips') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      const clips = Array.isArray(msg.clips) ? msg.clips : [];
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      if (!clips.length) {
        sendResponse({ ok: false, error: 'no_clips' });
        return;
      }
      let result = { ok: false, error: 'no_video_frame' };
      try {
        result = await chrome.tabs.sendMessage(tabId, {
          action: 'replaceClips',
          clips,
          force: true,
        });
      } catch (err) {
        result = { ok: false, error: String(err?.message || err) };
      }
      if (result?.ok && Array.isArray(result.clips)) {
        const entry = session.clipEntry(tabId);
        session.setClips(
          tabId,
          result.clips,
          entry?.pageUrl || '',
          result.pageKey || entry?.pageKey || '',
        );
      }
      sendResponse(result);
    })();
    return true;
  }

  if (msg?.action === 'getDetectedStreams') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      sendResponse({ ok: true, streams: streamsForTab(tabId) });
    })();
    return true;
  }

  if (msg?.action === 'clearDetectedStreams') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      if (tabId != null) {
        session.clearStreams(tabId);
        updateBadge(tabId);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  const tabActions = ['getVideoState', 'markStart', 'markEnd', 'clearPending', 'showBar'];
  if (tabActions.includes(msg?.action)) {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      sendResponse(await forwardToTab(tabId, { action: msg.action }));
    })();
    return true;
  }

  return false;
});
