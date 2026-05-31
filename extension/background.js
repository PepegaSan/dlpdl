import { apiUrl, buildJobBody, buildStreamJobBody } from './lib/clip-direct-api.js';
import { openClipDirectUi } from './lib/open-ui.js';
import { loadSettings } from './lib/storage.js';

const SESSION_KEY = 'detectedStreams';
const CLIPS_SESSION_KEY = 'tabClips';
const MAX_PER_TAB = 30;
const BADGE_COLOR = '#22c55e';

let tabClips = {};

chrome.storage.session.get(CLIPS_SESSION_KEY).then((stored) => {
  const persisted = stored[CLIPS_SESSION_KEY] || {};
  for (const [tabId, value] of Object.entries(persisted)) {
    if (!tabClips[tabId]) tabClips[tabId] = value;
  }
}).catch(() => {});

let clipsPersistTimer = null;
function persistClipsSoon() {
  if (clipsPersistTimer) return;
  clipsPersistTimer = setTimeout(() => {
    clipsPersistTimer = null;
    chrome.storage.session.set({ [CLIPS_SESSION_KEY]: tabClips }).catch(() => {});
  }, 250);
}

let memCache = {};

chrome.storage.session.get(SESSION_KEY).then((stored) => {
  const persisted = stored[SESSION_KEY] || {};
  for (const [tabId, list] of Object.entries(persisted)) {
    if (!memCache[tabId]) memCache[tabId] = list;
  }
}).catch(() => {});

try {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
} catch {
  /* ignore */
}

let persistTimer = null;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.session.set({ [SESSION_KEY]: memCache }).catch(() => {});
  }, 250);
}

function streamKind(url) {
  let path;
  let full;
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    full = url.toLowerCase();
  } catch {
    return null;
  }
  if (path.endsWith('.m3u8') || full.includes('.m3u8?') || full.includes('.m3u8&')) return 'hls';
  if (path.endsWith('.mpd') || full.includes('.mpd?')) return 'dash';
  if (path.endsWith('.f4m')) return 'hds';
  if (/\.(mp4|webm|mkv|mov)(\?|$)/.test(path) || /\.(mp4|webm|mkv|mov)(\?|&)/.test(full)) {
    return 'file';
  }
  if (/\.(m4a|mp3|aac|ogg)(\?|$)/.test(path)) return 'audio';
  return null;
}

function headersToMap(requestHeaders) {
  const map = {};
  if (Array.isArray(requestHeaders)) {
    for (const h of requestHeaders) {
      if (h?.name) map[h.name.toLowerCase()] = h.value || '';
    }
  }
  return map;
}

function updateBadge(tabId) {
  if (tabId == null || tabId < 0) return;
  const count = (memCache[tabId] || []).length;
  try {
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
  } catch {
    /* ignore */
  }
}

function addStream(tabId, entry) {
  if (tabId == null || tabId < 0) return;
  const list = memCache[tabId] ? memCache[tabId] : [];
  if (list.some((e) => e.url === entry.url)) return;
  list.unshift(entry);
  memCache[tabId] = list.slice(0, MAX_PER_TAB);
  persistSoon();
  updateBadge(tabId);
}

/** Primary sniffer: capture Referer/UA before the request is sent. */
function captureBeforeSendHeaders(details) {
  const { tabId, url, requestHeaders, type } = details;
  if (tabId == null || tabId < 0) return;
  const kind = streamKind(url);
  if (!kind) return;
  const headers = headersToMap(requestHeaders);
  addStream(tabId, {
    url,
    kind,
    type: type || '',
    referer: headers.referer || headers.origin || '',
    origin: headers.origin || '',
    userAgent: headers['user-agent'] || '',
    ts: Date.now(),
  });
}

/** Fallback when onBeforeSendHeaders misses (e.g. some iframe/CDN requests). */
function captureCompleted(details) {
  const { tabId, url, type, initiator, documentUrl } = details;
  if (tabId == null || tabId < 0) return;
  const kind = streamKind(url);
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
  addStream(tabId, {
    url,
    kind,
    type: type || '',
    referer,
    origin,
    userAgent: '',
    ts: Date.now(),
  });
}

try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        captureBeforeSendHeaders(details);
      } catch {
        /* never break the request */
      }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders'],
  );
} catch (err) {
  console.error('Clip-Direct: onBeforeSendHeaders registration failed', err);
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    try {
      captureCompleted(details);
    } catch {
      /* never break */
    }
  },
  { urls: ['<all_urls>'] },
);

function clearTabCaptureState(tabId) {
  if (tabId == null || tabId < 0) return;
  memCache[tabId] = [];
  persistSoon();
  updateBadge(tabId);
  if (tabClips[tabId]) {
    delete tabClips[tabId];
    persistClipsSoon();
  }
}

// Only clear on real top-level navigation (not SPA hash / tab metadata updates).
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === 'main_frame' && details.tabId >= 0) {
      clearTabCaptureState(details.tabId);
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (memCache[tabId]) {
    delete memCache[tabId];
    persistSoon();
  }
  if (tabClips[tabId]) {
    delete tabClips[tabId];
    persistClipsSoon();
  }
});

function detectedForTab(tabId) {
  return tabId != null && memCache[tabId] ? memCache[tabId] : [];
}

/** Prefer HLS — same source merge uses when user sends from the stream list. */
function pickBestStream(streams) {
  if (!streams?.length) return null;
  const hls = streams.find(
    (s) => s?.url && (s.kind === 'hls' || /\.m3u8(\?|$|&)/i.test(s.url)),
  );
  return hls || streams.find((s) => s?.url) || null;
}

function clipsForTab(tabId) {
  return tabId != null && tabClips[tabId] ? tabClips[tabId] : null;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function postJob(settings, body) {
  const url = apiUrl(settings.clipDirectBaseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text || res.statusText };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: true, data };
}

async function openUiIfNeeded(settings) {
  if (!settings.openUiAfterQueue) return;
  try {
    await openClipDirectUi(settings.clipDirectBaseUrl);
  } catch {
    /* ignore */
  }
}

async function queueStream(stream, pageUrl, clips, mergeClips) {
  if (!stream?.url) return { ok: false, error: 'no_stream' };
  const enriched = { ...stream };
  if (!enriched.referer) {
    const tabId = await getActiveTabId();
    if (tabId != null) {
      try {
        const tab = await chrome.tabs.get(tabId);
        enriched.referer = tab.url || pageUrl || enriched.documentUrl || '';
      } catch {
        enriched.referer = pageUrl || '';
      }
    } else {
      enriched.referer = pageUrl || '';
    }
  }
  const settings = await loadSettings();
  const body = buildStreamJobBody(settings, enriched, pageUrl, Array.isArray(clips) ? clips : [], !!mergeClips);
  const result = await postJob(settings, body);
  if (result.ok) await openUiIfNeeded(settings);
  return result;
}

async function queueClips(pageUrl, clips, mergeClips) {
  if (!clips?.length) return { ok: false, error: 'no_clips' };
  const tabId = await getActiveTabId();
  const stream = pickBestStream(detectedForTab(tabId));
  if (stream?.url) {
    return queueStream(stream, pageUrl, clips, mergeClips);
  }
  const settings = await loadSettings();
  const body = buildJobBody(settings, pageUrl, clips, !!mergeClips);
  const result = await postJob(settings, body);
  if (result.ok) await openUiIfNeeded(settings);
  return result;
}

async function sendToTab(tabId, payload) {
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === 'queueClips') {
    queueClips(msg.pageUrl, msg.clips, msg.mergeClips)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.action === 'reportClips') {
    const tabId = _sender?.tab?.id;
    if (tabId != null && tabId >= 0) {
      const clips = Array.isArray(msg.clips) ? msg.clips : [];
      if (clips.length) {
        tabClips[tabId] = {
          clips,
          pageUrl: msg.pageUrl || '',
          pageKey: msg.pageKey || '',
          ts: Date.now(),
        };
      } else if (tabClips[tabId]) {
        delete tabClips[tabId];
      }
      persistClipsSoon();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.action === 'getTabClips') {
    (async () => {
      const tabId = msg.tabId ?? (await getActiveTabId());
      sendResponse({ ok: true, tabClips: clipsForTab(tabId) });
    })();
    return true;
  }

  if (msg?.action === 'removeTabClip') {
    (async () => {
      const tabId = msg.tabId ?? (await getActiveTabId());
      const entry = tabId != null ? tabClips[tabId] : null;
      if (!entry?.clips) {
        sendResponse({ ok: false, error: 'no_clips', clips: [] });
        return;
      }
      const index = Number(msg.index);
      const clips = entry.clips.slice();
      if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
        sendResponse({ ok: false, error: 'bad_index', clips });
        return;
      }
      const pageKey = entry.pageKey || '';
      clips.splice(index, 1);
      if (clips.length) {
        entry.clips = clips;
        entry.ts = Date.now();
      } else {
        delete tabClips[tabId];
      }
      persistClipsSoon();
      try {
        chrome.tabs.sendMessage(tabId, { action: 'removeClip', pageKey, index });
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true, clips });
    })();
    return true;
  }

  if (msg?.action === 'getDetectedStreams') {
    (async () => {
      const tabId = msg.tabId ?? (await getActiveTabId());
      sendResponse({ ok: true, streams: detectedForTab(tabId) });
    })();
    return true;
  }

  if (msg?.action === 'queueStream') {
    queueStream(msg.stream, msg.pageUrl, msg.clips, msg.mergeClips)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.action === 'clearDetectedStreams') {
    (async () => {
      const tabId = msg.tabId ?? (await getActiveTabId());
      if (tabId != null) {
        memCache[tabId] = [];
        persistSoon();
        updateBadge(tabId);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  const tabActions = ['getVideoState', 'markStart', 'markEnd', 'clearPending', 'showBar'];
  if (tabActions.includes(msg?.action)) {
    (async () => {
      const tabId = msg.tabId ?? (await getActiveTabId());
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      sendResponse(await sendToTab(tabId, { action: msg.action }));
    })();
    return true;
  }

  return false;
});
