import {
  buildPageJobPayload,
  buildStreamJobPayload,
  jobsEndpoint,
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
  needsSniffedStreamForPage,
  preferBestStream,
  requestHeadersMap,
  usableStreams,
} from './lib/media-sniffer.js';
import { loadClipClipboard, saveClipClipboard } from './lib/clip-clipboard.js';
import { openClipDirectUi } from './lib/open-ui.js';
import { collectStreamCookies, mergeCookieHeader } from './lib/browser-cookies.js';
import { enrichStreamForQueue } from './lib/stream-headers.js';
import { loadSettings } from './lib/storage.js';
import { TabSessionStore } from './lib/tab-session.js';

const BADGE_COLOR = '#22c55e';
const session = new TabSessionStore();

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
  updateBadge(tabId);
}

function rememberTabCookies(tabId, url, cookieHeader) {
  if (!cookieHeader || tabId == null || tabId < 0) return;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/turboviplay|turbosplayer|emturbovid|cloudatacdn|dood\.video|doodstream/.test(host)) {
      session.rememberRequestCookies(tabId, cookieHeader);
    }
  } catch {
    /* ignore */
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

async function maybeOpenUi(settings) {
  if (!settings.openUiAfterQueue) return;
  try {
    await openClipDirectUi(settings.clipDirectBaseUrl);
  } catch {
    /* ignore */
  }
}

async function queueStream(stream, pageUrl, clips, mergeClips) {
  if (!stream?.url) {
    return { ok: false, error: 'no_stream' };
  }
  const tabId = await activeTabId();
  let tabUrl = pageUrl || '';
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url || tabUrl;
    } catch {
      /* ignore */
    }
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
  const settings = await loadSettings();
  const body = buildStreamJobPayload(
    settings,
    enriched,
    pageUrl,
    Array.isArray(clips) ? clips : [],
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

async function queueClips(pageUrl, clips, mergeClips) {
  if (!clips?.length) {
    return { ok: false, error: 'no_clips' };
  }
  const settings = await loadSettings();
  const tabId = await activeTabId();

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
    return queueStream(stream, pageUrl, clips, mergeClips);
  }

  return {
    ok: false,
    errorKey: isHlsEmbedPageUrl(pageUrl) ? 'error.hlsEmbedNoStream' : 'error.shellPagePhp',
  };
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
    queueClips(msg.pageUrl, msg.clips, msg.mergeClips)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.action === 'queueStream') {
    queueStream(msg.stream, msg.pageUrl, msg.clips, msg.mergeClips)
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
      session.setClips(tabId, clips, msg.pageUrl, msg.pageKey);
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
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      let result = { ok: false, error: 'no_owner' };
      try {
        result = await chrome.tabs.sendMessage(tabId, {
          action: 'setClipMergeIncluded',
          pageKey: msg.pageKey,
          index: msg.index,
          includeInMerge: msg.includeInMerge,
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

  if (msg?.action === 'updateTabClipTimes') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      let result = { ok: false, error: 'no_owner' };
      try {
        result = await chrome.tabs.sendMessage(tabId, {
          action: 'updateClipTimes',
          pageKey: msg.pageKey,
          index: msg.index,
          start: msg.start,
          end: msg.end,
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
