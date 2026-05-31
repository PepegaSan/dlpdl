/* Content script: classic script (no ES imports — Chrome loads this without type: module). */

function formatClockTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600);
  if (hr > 0) {
    return `${hr}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function draftKeyForHref(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id) return `youtube:${id}`;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const id = url.searchParams.get('v');
      if (id) return `youtube:${id}`;
    }
    url.hash = '';
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

function submitUrlForHref(href) {
  try {
    const url = new URL(href);
    url.hash = '';
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
      url.searchParams.delete('t');
      url.searchParams.delete('start');
    }
    return url.toString();
  } catch {
    return href;
  }
}

const CLIPS_KEY = 'clipDraftByUrl';
const BAR_HIDDEN_KEY = 'clipDirectBarHidden';
const RELOAD_HINT_ID = 'clip-direct-reload-hint';

const IS_TOP_FRAME = (() => {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
})();

let contextTeardownDone = false;
let navIntervalId = null;
let syncIntervalId = null;

/**
 * Tell the background which clips belong to this tab. Used so the popup can
 * attach cuts to a sniffed stream URL even when the video lives in a
 * cross-origin iframe (StreamSB/Streamtape) that the popup can't reach.
 */
function reportClipsToBackground() {
  if (handleInvalidExtensionContext()) {
    return;
  }
  try {
    const key = storageKey();
    chrome.runtime.sendMessage({
      action: 'reportClips',
      clips: sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [],
      pageUrl: submitUrlForHref(location.href),
      pageKey: key,
      isTop: IS_TOP_FRAME,
    });
  } catch {
    /* ignore — background may be asleep, popup reads storage anyway */
  }
}

/** After extension reload, old tabs must refresh (F5). */
function isExtensionContextValid() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function handleInvalidExtensionContext() {
  if (contextTeardownDone) {
    return true;
  }
  if (isExtensionContextValid()) {
    return false;
  }
  contextTeardownDone = true;
  if (navIntervalId != null) {
    clearInterval(navIntervalId);
    navIntervalId = null;
  }
  if (syncIntervalId != null) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  if (overlayRoot) {
    try {
      overlayRoot.remove();
    } catch {
      /* ignore */
    }
    overlayRoot = null;
  }
  if (!document.getElementById(RELOAD_HINT_ID)) {
    const hint = document.createElement('div');
    hint.id = RELOAD_HINT_ID;
    hint.textContent = 'Clip-Direct Extension wurde aktualisiert — Seite neu laden (F5)';
    hint.style.cssText =
      'position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:10px 14px;' +
      'background:#b02a37;color:#fff;border-radius:8px;font:13px system-ui,sans-serif;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.4);max-width:280px;';
    document.documentElement.appendChild(hint);
  }
  return true;
}

function isFiniteNum(x) {
  return typeof x === 'number' && x === x && x !== Infinity && x !== -Infinity;
}

/** chrome.storage.local — always via callback (content scripts). */
function storageLocalGet(keys) {
  if (handleInvalidExtensionContext()) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve({});
      return;
    }
    try {
      chrome.storage.local.get(keys, (data) => {
        if (handleInvalidExtensionContext()) {
          resolve({});
          return;
        }
        resolve(chrome.runtime.lastError ? {} : data || {});
      });
    } catch {
      handleInvalidExtensionContext();
      resolve({});
    }
  });
}

function storageLocalSet(items) {
  if (handleInvalidExtensionContext()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }
    try {
      chrome.storage.local.set(items, () => {
        resolve();
      });
    } catch {
      handleInvalidExtensionContext();
      resolve();
    }
  });
}

function storageLocalRemove(keys) {
  if (handleInvalidExtensionContext()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }
    try {
      chrome.storage.local.remove(keys, () => {
        resolve();
      });
    } catch {
      handleInvalidExtensionContext();
      resolve();
    }
  });
}

function barHiddenFromStorage(data) {
  return !!(data?.[BAR_HIDDEN_KEY] || data?.metubeBarHidden);
}

function safeVideoTime(video) {
  if (!video || !video.isConnected) {
    return 0;
  }
  if (typeof HTMLVideoElement !== 'undefined' && !(video instanceof HTMLVideoElement)) {
    return 0;
  }
  try {
    if (video.readyState < 1) {
      return 0;
    }
    const t = video.currentTime;
    return isFiniteNum(t) && t >= 0 ? t : 0;
  } catch {
    return 0;
  }
}

function videoArea(v) {
  try {
    if (!v?.isConnected) return 0;
    return v.clientWidth * v.clientHeight;
  } catch {
    return 0;
  }
}

function getActiveVideo() {
  let candidates = [];
  try {
    candidates = Array.from(document.querySelectorAll('video')).filter((v) => {
      try {
        return v.isConnected && v.readyState >= 1;
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  if (!candidates.length) {
    return null;
  }
  return candidates.reduce((best, v) => (videoArea(v) > videoArea(best) ? v : best));
}

function shouldShowBar() {
  const v = getActiveVideo();
  if (!v) return false;
  try {
    if (window.top === window.self) return true;
  } catch {
    return true;
  }
  return v.clientWidth >= 240 && v.clientHeight >= 135;
}

let pendingStart = null;
let overlayRoot = null;
let sessionBarHidden = false;
/** @type {Record<string, { start: string, end: string }[]>} */
const sessionClipsByKey = {};

function storageKey() {
  return draftKeyForHref(location.href);
}

function pendingStorageItemKey() {
  return `pending:${storageKey()}`;
}

function loadPendingFromStorage() {
  const key = pendingStorageItemKey();
  return storageLocalGet(key).then((data) => {
    const value = data[key];
    return typeof value === 'string' && value ? value : null;
  });
}

function savePendingToStorage(value) {
  const key = pendingStorageItemKey();
  if (value) {
    return storageLocalSet({ [key]: value });
  }
  return storageLocalRemove(key);
}

function ensurePendingLoaded() {
  if (pendingStart) {
    return Promise.resolve(pendingStart);
  }
  return loadPendingFromStorage().then((stored) => {
    pendingStart = stored;
    return pendingStart;
  });
}

async function loadClipsForPage() {
  const key = storageKey();
  if (sessionClipsByKey[key]?.length) {
    return [...sessionClipsByKey[key]];
  }
  const data = await storageLocalGet(CLIPS_KEY);
  const all = data[CLIPS_KEY] || {};
  const list = all[key] ? [...all[key]] : [];
  sessionClipsByKey[key] = list;
  if (list.length) {
    reportClipsToBackground();
  }
  return list;
}

async function appendClip(clip) {
  const key = storageKey();
  const list = sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [];
  list.push(clip);
  sessionClipsByKey[key] = list;
  const data = await storageLocalGet(CLIPS_KEY);
  const all = data[CLIPS_KEY] || {};
  all[key] = list;
  await storageLocalSet({ [CLIPS_KEY]: all });
  reportClipsToBackground();
  return list;
}

/**
 * Remove one saved clip (by index) from this frame's draft + persistent
 * storage, then re-report. Used by the popup to drop a marked section before
 * it is sent to Clip-Direct — also works for cross-origin hoster iframes, since the
 * removal message is broadcast to all frames and only the owning one acts.
 */
async function removeClipAt(index) {
  const key = storageKey();
  const list = sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [];
  if (index >= 0 && index < list.length) {
    list.splice(index, 1);
  }
  sessionClipsByKey[key] = list;
  const data = await storageLocalGet(CLIPS_KEY);
  const all = data[CLIPS_KEY] || {};
  if (list.length) {
    all[key] = list;
  } else {
    delete all[key];
  }
  await storageLocalSet({ [CLIPS_KEY]: all });
  reportClipsToBackground();
  updateOverlayUiNow();
  return { ok: true, clips: list };
}

function updateOverlayUiNow() {
  if (!overlayRoot) return;
  const statusEl = overlayRoot.querySelector('[data-role="status"]');
  const btnEnd = overlayRoot.querySelector('[data-action="end"]');
  const btnClear = overlayRoot.querySelector('[data-action="clear"]');
  if (!statusEl || !btnEnd || !btnClear) return;
  btnEnd.disabled = !pendingStart;
  btnClear.hidden = !pendingStart;
  const key = storageKey();
  const clipCount = sessionClipsByKey[key]?.length ?? 0;
  if (pendingStart) {
    statusEl.textContent = `Start ${pendingStart} — spule zum Ende, dann Ende`;
  } else if (clipCount > 0) {
    statusEl.textContent = `${clipCount} Clip(s) — Extension-Popup senden`;
  } else {
    const v = getActiveVideo();
    statusEl.textContent = v ? `Jetzt: ${formatClockTime(safeVideoTime(v))}` : 'Kein Video';
  }
}

function doMarkStart() {
  const video = getActiveVideo();
  if (!video) {
    return Promise.resolve({ ok: false, error: 'no_video' });
  }
  pendingStart = formatClockTime(safeVideoTime(video));
  updateOverlayUiNow();
  return savePendingToStorage(pendingStart).then(() => {
    updateOverlayUiNow();
    syncOverlayState();
    return {
      ok: true,
      pendingStart,
      pageUrl: submitUrlForHref(location.href),
      pageKey: storageKey(),
    };
  });
}

function doMarkEnd() {
  return ensurePendingLoaded().then((start) => {
    const video = getActiveVideo();
    if (!video) {
      return { ok: false, error: 'no_video' };
    }
    if (!start) {
      return { ok: false, error: 'no_pending_start' };
    }
    const end = formatClockTime(safeVideoTime(video));
    const clip = { start, end };
    pendingStart = null;
    updateOverlayUiNow();
    return savePendingToStorage(null)
      .then(() => appendClip(clip))
      .then((clips) => {
        updateOverlayUiNow();
        syncOverlayState();
        return {
          ok: true,
          clip,
          clips,
          pageUrl: submitUrlForHref(location.href),
          pageKey: storageKey(),
        };
      });
  });
}

function doClearPending() {
  pendingStart = null;
  updateOverlayUiNow();
  return savePendingToStorage(null).then(() => {
    updateOverlayUiNow();
    reportClipsToBackground();
    return { ok: true };
  });
}

function getVideoStateResponse() {
  const pageUrl = submitUrlForHref(location.href);
  const pageKey = storageKey();
  return ensurePendingLoaded().then(async (pending) => {
    const clips = await loadClipsForPage();
    const video = getActiveVideo();
    if (!video) {
      return {
        ok: false,
        error: 'no_video',
        pageUrl,
        pageKey,
        pendingStart: pending,
        clips,
      };
    }
    return {
      ok: true,
      currentTime: safeVideoTime(video),
      duration: isFiniteNum(video.duration) ? video.duration : 0,
      formatted: formatClockTime(safeVideoTime(video)),
      pageUrl,
      pageKey,
      pendingStart: pending,
      clips,
    };
  });
}

function injectOverlayStyles() {
  if (document.getElementById('clip-direct-clip-bar-style')) return;
  const style = document.createElement('style');
  style.id = 'clip-direct-clip-bar-style';
  style.textContent = `
    #clip-direct-clip-bar {
      position: fixed;
      right: 12px;
      bottom: 72px;
      z-index: 2147483647;
      isolation: isolate;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      max-width: min(420px, calc(100vw - 24px));
      padding: 8px 10px;
      border-radius: 10px;
      background: rgba(20, 20, 24, 0.92);
      color: #f2f2f2;
      font: 12px/1.3 system-ui, sans-serif;
      box-shadow: 0 4px 20px rgba(0,0,0,0.45);
      pointer-events: auto;
      user-select: none;
    }
    #clip-direct-clip-bar button {
      cursor: pointer;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 6px 10px;
      background: #2d2d35;
      color: #fff;
      font: inherit;
      pointer-events: auto;
      position: relative;
      z-index: 1;
    }
    #clip-direct-clip-bar button:hover:not(:disabled) {
      background: #3d3d48;
    }
    #clip-direct-clip-bar button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    #clip-direct-clip-bar button.clip-direct-primary {
      background: #0d6efd;
      border-color: #0d6efd;
    }
    #clip-direct-clip-bar .clip-direct-status {
      flex: 1 1 100%;
      color: #9ecbff;
      min-height: 1.2em;
    }
    #clip-direct-clip-bar .clip-direct-hide {
      padding: 4px 8px;
      font-size: 11px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function ensureOverlay() {
  if (overlayRoot || !shouldShowBar()) return;
  injectOverlayStyles();
  const bar = document.createElement('div');
  bar.id = 'clip-direct-clip-bar';
  bar.innerHTML = `
    <button type="button" class="clip-direct-primary" data-action="start">Start</button>
    <button type="button" data-action="end" disabled>Ende</button>
    <button type="button" data-action="clear" hidden>Abbrechen</button>
    <span class="clip-direct-status" data-role="status"></span>
    <button type="button" class="clip-direct-hide" data-action="hide" title="Leiste ausblenden">✕</button>
  `;

  function bindBarButton(selector, handler) {
    const btn = bar.querySelector(selector);
    let busy = false;
    btn.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (busy) return;
        busy = true;
        Promise.resolve(handler(e)).finally(() => {
          busy = false;
        });
      },
      true,
    );
  }

  bindBarButton('[data-action="start"]', () => {
    doMarkStart().catch(() => updateOverlayUiNow());
  });

  bindBarButton('[data-action="end"]', () => {
    doMarkEnd().catch(() => updateOverlayUiNow());
  });

  bindBarButton('[data-action="clear"]', () => {
    doClearPending().catch(() => updateOverlayUiNow());
  });

  bindBarButton('[data-action="hide"]', () => {
    sessionBarHidden = true;
    bar.remove();
    overlayRoot = null;
    storageLocalSet({ [BAR_HIDDEN_KEY]: true });
  });

  document.documentElement.appendChild(bar);
  overlayRoot = bar;
  syncOverlayState();
}

function syncOverlayState() {
  if (!overlayRoot) return;
  try {
    const statusEl = overlayRoot.querySelector('[data-role="status"]');
    const btnEnd = overlayRoot.querySelector('[data-action="end"]');
    const btnClear = overlayRoot.querySelector('[data-action="clear"]');
    ensurePendingLoaded()
      .then(async (pending) => {
        const clips = await loadClipsForPage();
        btnEnd.disabled = !pending;
        btnClear.hidden = !pending;
        if (pending) {
          statusEl.textContent = `Start ${pending} — spule zum Ende, dann Ende`;
        } else if (clips.length) {
          statusEl.textContent = `${clips.length} Clip(s) — Extension-Popup senden`;
        } else {
          const v = getActiveVideo();
          statusEl.textContent = v
            ? `Jetzt: ${formatClockTime(safeVideoTime(v))}`
            : 'Kein Video';
        }
      })
      .catch(() => {
        if (statusEl) statusEl.textContent = 'Video nicht bereit';
      });
  } catch {
    /* ignore — some players break DOM access */
  }
}

function initBar() {
  if (sessionBarHidden) return;
  storageLocalGet([BAR_HIDDEN_KEY, 'metubeBarHidden']).then((data) => {
    if (barHiddenFromStorage(data) || sessionBarHidden) return;
    if (shouldShowBar()) {
      ensureOverlay();
      return;
    }
    const obs = new MutationObserver(() => {
      if (shouldShowBar()) {
        obs.disconnect();
        ensureOverlay();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 60000);
  });
}

let lastHref = location.href;
navIntervalId = setInterval(() => {
  if (handleInvalidExtensionContext()) {
    return;
  }
  if (location.href !== lastHref) {
    lastHref = location.href;
    pendingStart = null;
    if (overlayRoot) syncOverlayState();
    else initBar();
  }
}, 800);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Clip removal must reach the frame that actually owns the clips, which may
  // be a cross-origin hoster iframe rather than the top frame. The message is
  // broadcast to every frame; only the one whose pageKey matches acts on it.
  if (msg?.action === 'removeClip') {
    if (handleInvalidExtensionContext()) {
      sendResponse({ ok: false, error: 'context_invalidated', hint: 'reload_tab' });
      return true;
    }
    if (msg.pageKey && msg.pageKey !== storageKey()) {
      return false; // another frame owns these clips
    }
    removeClipAt(Number(msg.index)).then(sendResponse);
    return true;
  }

  // Popup RPC is answered only by the top frame, so cross-origin iframes
  // (which now also run this script via all_frames) never clobber the
  // response on normal sites. Iframes still show their own clip bar and
  // report clips to the background.
  if (!IS_TOP_FRAME) {
    return false;
  }
  if (handleInvalidExtensionContext()) {
    sendResponse({ ok: false, error: 'context_invalidated', hint: 'reload_tab' });
    return true;
  }
  if (msg?.action === 'getVideoState') {
    getVideoStateResponse().then(sendResponse);
    return true;
  }
  if (msg?.action === 'markStart') {
    doMarkStart().then(sendResponse);
    return true;
  }
  if (msg?.action === 'markEnd') {
    doMarkEnd().then(sendResponse);
    return true;
  }
  if (msg?.action === 'clearPending') {
    doClearPending().then(sendResponse);
    return true;
  }
  if (msg?.action === 'showBar') {
    storageLocalSet({ [BAR_HIDDEN_KEY]: false }).then(() => {
      initBar();
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

if (!handleInvalidExtensionContext()) {
  initBar();
}
syncIntervalId = setInterval(() => {
  if (handleInvalidExtensionContext()) {
    return;
  }
  if (!overlayRoot && shouldShowBar()) {
    storageLocalGet([BAR_HIDDEN_KEY, 'metubeBarHidden']).then((d) => {
      if (!barHiddenFromStorage(d)) ensureOverlay();
    });
  } else if (overlayRoot) {
    syncOverlayState();
  }
}, 2000);
