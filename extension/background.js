import {
  buildPageJobPayload,
  buildStreamJobPayload,
  jobsEndpoint,
} from './lib/jobs-client.js';
import {
  classifyMediaUrl,
  isLikelyPageShellUrl,
  isUsableStreamUrl,
  preferBestStream,
  requestHeadersMap,
  usableStreams,
} from './lib/media-sniffer.js';
import { openClipDirectUi } from './lib/open-ui.js';
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

function onBeforeSendHeaders(details) {
  const { tabId, url, requestHeaders, type } = details;
  if (tabId == null || tabId < 0) return;
  const kind = classifyMediaUrl(url);
  if (!kind) return;
  const headers = requestHeadersMap(requestHeaders);
  session.addStream(tabId, {
    url,
    kind,
    type: type || '',
    referer: headers.referer || headers.origin || '',
    origin: headers.origin || '',
    userAgent: headers['user-agent'] || '',
    ts: Date.now(),
  });
  updateBadge(tabId);
}

function onCompleted(details) {
  const { tabId, url, type, initiator, documentUrl } = details;
  if (tabId == null || tabId < 0) return;
  const kind = classifyMediaUrl(url);
  if (!kind) return;
  const referer = initiator || documentUrl || '';
  let origin = '';
  if (referer) {
    try {
      origin = new URL(referer).origin;
    } catch {
      /* ignore */
    }
  }
  session.addStream(tabId, {
    url,
    kind,
    type: type || '',
    referer,
    origin,
    userAgent: '',
    ts: Date.now(),
  });
  updateBadge(tabId);
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

async function postJob(settings, body) {
  const url = jobsEndpoint(settings.clipDirectBaseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  const enriched = { ...stream };
  if (!enriched.referer) {
    const tabId = await activeTabId();
    if (tabId != null) {
      try {
        const tab = await chrome.tabs.get(tabId);
        enriched.referer = tab.url || pageUrl || '';
      } catch {
        enriched.referer = pageUrl || '';
      }
    } else {
      enriched.referer = pageUrl || '';
    }
  }
  const settings = await loadSettings();
  const body = buildStreamJobPayload(
    settings,
    enriched,
    pageUrl,
    Array.isArray(clips) ? clips : [],
    !!mergeClips,
  );
  const result = await postJob(settings, body);
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

  const pickUrl = (url) => (url && isUsableStreamUrl(url) ? url : null);

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
          const l = u.toLowerCase();
          return /\.m3u8|m3u8%2f|\.mp4|\.webm|\/hls\//.test(l);
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
          const media = urls.find(looksLikeMedia) || urls.find((u) => /^https?:/i.test(u));
          if (media) {
            best = media;
            bestArea = area;
          }
        }
        return best;
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
  const sniffed = preferBestStream(usableStreams(session.streams(tabId)));
  if (sniffed?.url) {
    return sniffed;
  }
  return streamFromActiveVideo(tabId, pageUrl);
}

async function queueClips(pageUrl, clips, mergeClips) {
  if (!clips?.length) {
    return { ok: false, error: 'no_clips' };
  }
  const settings = await loadSettings();
  const tabId = await activeTabId();

  // MeTube behaviour: "In Queue" sends the page URL so yt-dlp can use site extractors
  // (YouTube, Vimeo, …). Do not replace that with a sniffed .php CDN URL.
  if (!isLikelyPageShellUrl(pageUrl)) {
    const body = buildPageJobPayload(settings, pageUrl, clips, !!mergeClips);
    const result = await postJob(settings, body);
    if (result.ok) await maybeOpenUi(settings);
    return result;
  }

  const stream = await pickStreamForShellPage(tabId, pageUrl);
  if (stream?.url && isUsableStreamUrl(stream.url)) {
    return queueStream(stream, pageUrl, clips, mergeClips);
  }

  return {
    ok: false,
    error:
      'Diese Seite (.php) ist nur über einen erkannten Stream ladbar. Video kurz abspielen, F5, dann „Mit Schnitt“ am Stream — oder prüfen ob unter „Erkannte Streams“ etwas steht.',
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
      const result = session.removeClipAt(tabId, Number(msg.index));
      if (result.ok && tabId != null) {
        try {
          chrome.tabs.sendMessage(tabId, {
            action: 'removeClip',
            pageKey: result.pageKey,
            index: msg.index,
          });
        } catch {
          /* ignore */
        }
      }
      sendResponse(result);
    })();
    return true;
  }

  if (msg?.action === 'getDetectedStreams') {
    (async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      sendResponse({ ok: true, streams: session.streams(tabId) });
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
