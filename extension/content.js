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

function parseClockTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : NaN;
  }
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const compact = s.toLowerCase().match(/^(\d+)([hms])?$/);
  if (compact) {
    const n = parseInt(compact[1], 10);
    const unit = compact[2] || 's';
    if (unit === 'h') return n * 3600;
    if (unit === 'm') return n * 60;
    return n;
  }
  const parts = s.split(':').map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function normalizeClockTime(value) {
  const sec = parseClockTime(value);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return formatClockTime(sec);
}

function cdT(key, params) {
  if (typeof window.clipDirectT === 'function') {
    return window.clipDirectT(key, params);
  }
  return key;
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
let barTickId = null;

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
  stopBarTick();
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
    hint.textContent = cdT('bar.reloadHint');
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

function mediaUrlLooksLikeStream(url) {
  if (window.ClipDirectStreamUrl?.mediaUrlLooksLikeStream) {
    return window.ClipDirectStreamUrl.mediaUrlLooksLikeStream(url);
  }
  if (!url || typeof url !== 'string') {
    return false;
  }
  const u = url.toLowerCase();
  if (u.startsWith('blob:') || u.startsWith('data:')) {
    return false;
  }
  if (!/^https?:\/\//i.test(u)) {
    return false;
  }
  if (/\.(ts|m4s)(\?|$)/.test(u) && !u.includes('.m3u8')) {
    return false;
  }
  return /\.m3u8|m3u8%2f|format=m3u8|\.mp4|\.webm|\.mkv|cloudatacdn\.com/i.test(u);
}

function getVideoMediaUrlFromPage() {
  const video = getActiveVideo();
  if (video) {
    const urls = collectVideoSourceUrls(video);
    const fromVideo = urls.find(mediaUrlLooksLikeStream);
    if (fromVideo) {
      return Promise.resolve({ ok: true, url: fromVideo });
    }
  }
  const pageM3u8 = findM3u8UrlsInPage();
  if (pageM3u8.length) {
    return Promise.resolve({ ok: true, url: pageM3u8[0] });
  }
  if (!video) {
    return Promise.resolve({ ok: false, error: 'no_video' });
  }
  const urls = collectVideoSourceUrls(video);
  const url = urls.find(mediaUrlLooksLikeStream);
  if (!url) {
    return Promise.resolve({ ok: false, error: 'no_media_url' });
  }
  return Promise.resolve({ ok: true, url });
}

function findM3u8UrlsInPage() {
  const found = new Set();
  const re = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
  const scan = (text) => {
    if (!text) return;
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      found.add(match[0].replace(/\\/g, ''));
    }
  };
  try {
    scan(document.documentElement?.innerHTML || '');
    for (const script of document.querySelectorAll('script')) {
      scan(script.textContent || script.innerHTML || '');
    }
  } catch {
    /* ignore */
  }
  return [...found].filter(mediaUrlLooksLikeStream);
}

function collectVideoSourceUrls(video) {
  const urls = [];
  const push = (u) => {
    if (u && typeof u === 'string') {
      urls.push(u);
    }
  };
  push(video.currentSrc);
  push(video.src);
  for (const source of video.querySelectorAll('source')) {
    push(source.src);
  }
  push(video.getAttribute('data-src'));
  push(video.getAttribute('data-url'));
  return urls.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:'));
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

async function persistClipsForKey(key, list) {
  sessionClipsByKey[key] = list;
  const data = await storageLocalGet(CLIPS_KEY);
  const all = data[CLIPS_KEY] || {};
  if (list.length) {
    all[key] = list;
  } else {
    delete all[key];
  }
  await storageLocalSet({ [CLIPS_KEY]: all });
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
  return list;
}

async function reportStoredClipsOnce() {
  const key = storageKey();
  await loadClipsForPage();
  if (sessionClipsByKey[key]?.length) {
    reportClipsToBackground();
  }
}

async function appendClip(clip) {
  const key = storageKey();
  const list = sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [];
  list.push(clip);
  await persistClipsForKey(key, list);
  reportClipsToBackground();
  return list;
}

async function updateClipTimesAt(index, startRaw, endRaw) {
  const key = storageKey();
  if (!sessionClipsByKey[key]?.length) {
    await loadClipsForPage();
  }
  const current = sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [];
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    return { ok: false, error: 'bad_index', clips: current, pageKey: key };
  }
  const start = normalizeClockTime(startRaw);
  const end = normalizeClockTime(endRaw);
  if (!start || !end) {
    return { ok: false, error: 'invalid_time', clips: current, pageKey: key };
  }
  const startSec = parseClockTime(start);
  const endSec = parseClockTime(end);
  if (endSec <= startSec) {
    return { ok: false, error: 'end_before_start', clips: current, pageKey: key };
  }
  current[index] = { ...current[index], start, end };
  await persistClipsForKey(key, current);
  reportClipsToBackground();
  updateOverlayUiNow();
  return { ok: true, clips: current, pageKey: key };
}

async function setClipMergeIncludedAt(index, includeInMerge) {
  const key = storageKey();
  const list = sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [];
  if (!list.length) {
    await loadClipsForPage();
  }
  const current = sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [];
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    return { ok: false, error: 'bad_index', clips: current, pageKey: key };
  }
  current[index] = { ...current[index], includeInMerge: !!includeInMerge };
  await persistClipsForKey(key, current);
  reportClipsToBackground();
  return { ok: true, clips: current, pageKey: key };
}

/**
 * Remove one saved clip (by index) from this frame's draft + persistent
 * storage, then re-report. Used by the popup to drop a marked section before
 * it is sent to Clip-Direct — also works for cross-origin hoster iframes, since the
 * removal message is broadcast to all frames and only the owning one acts.
 */
async function removeClipAt(index) {
  const key = storageKey();
  await loadClipsForPage();
  const list = sessionClipsByKey[key] ? [...sessionClipsByKey[key]] : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return { ok: false, error: 'bad_index', clips: list, pageKey: key };
  }
  list.splice(index, 1);
  await persistClipsForKey(key, list);
  reportClipsToBackground();
  updateOverlayUiNow();
  return { ok: true, clips: list, pageKey: key };
}

async function replaceClipsForPage(clips) {
  const key = storageKey();
  const list = Array.isArray(clips) ? clips.map((c) => ({ ...c })) : [];
  await persistClipsForKey(key, list);
  reportClipsToBackground();
  updateOverlayUiNow();
  return { ok: true, clips: list, pageKey: key };
}

/** Same rule as selectedClips() in the extension: checked and end after start. */
function clipIsSendable(clip) {
  return !!clip && clip.includeInMerge !== false
    && parseClockTime(clip.end) > parseClockTime(clip.start);
}

/** Markers, pending row and send label from the pending start + this frame's clips. */
function renderBar(clips) {
  if (!overlayRoot) return;
  const btnStart = overlayRoot.querySelector('[data-action="start"]');
  const btnEnd = overlayRoot.querySelector('[data-action="end"]');
  const btnSend = overlayRoot.querySelector('[data-action="send"]');
  const pendingRow = overlayRoot.querySelector('[data-role="pending"]');
  if (!btnStart || !btnEnd || !btnSend || !pendingRow) return;
  btnEnd.disabled = !pendingStart;
  // Highlight whichever marker comes next, like the popup.
  btnStart.classList.toggle('clip-direct-next', !pendingStart);
  btnEnd.classList.toggle('clip-direct-next', !!pendingStart);
  pendingRow.hidden = !pendingStart;
  const sendable = clips.filter(clipIsSendable).length;
  // No clips sends the whole video; clips that are all unchecked/invalid send nothing.
  btnSend.textContent = clips.length
    ? cdT('bar.sendClips', { count: sendable })
    : cdT('bar.sendFull');
  btnSend.disabled = clips.length > 0 && sendable === 0;
  btnSend.title = btnSend.disabled ? cdT('bar.sendNoneTitle') : '';
  btnSend.classList.toggle('clip-direct-primary', sendable > 0);
  tickBar();
}

/** Live clock + time since the pending start; runs only while the bar is shown. */
function tickBar() {
  if (!overlayRoot) return;
  const nowEl = overlayRoot.querySelector('[data-role="now"]');
  const pendingEl = overlayRoot.querySelector('[data-role="pending-text"]');
  const video = getActiveVideo();
  const now = video ? safeVideoTime(video) : null;
  if (nowEl) nowEl.textContent = now != null ? formatClockTime(now) : '--:--';
  if (pendingEl && pendingStart) {
    const elapsed = now != null ? now - parseClockTime(pendingStart) : NaN;
    pendingEl.textContent = elapsed >= 1
      ? cdT('bar.pendingRunning', { start: pendingStart, elapsed: formatClockTime(elapsed) })
      : cdT('bar.pending', { start: pendingStart });
  }
}

let barStatusTimer = null;

/** tone: busy | ok | warn | error — ok messages fade after a few seconds. */
function setBarStatus(text, tone = '') {
  const el = overlayRoot?.querySelector('[data-role="status"]');
  if (!el) return;
  clearTimeout(barStatusTimer);
  el.textContent = text;
  el.hidden = !text;
  el.dataset.tone = tone;
  if (tone === 'ok') {
    barStatusTimer = setTimeout(() => setBarStatus(''), 5000);
  }
}

function updateOverlayUiNow() {
  renderBar(sessionClipsByKey[storageKey()] || []);
}

function sendFromBar() {
  setBarStatus(cdT('bar.status.sending'), 'busy');
  return chrome.runtime.sendMessage({
    action: 'queueFromPage',
    pageUrl: submitUrlForHref(location.href),
  }).then((res) => {
    if (res?.ok) {
      setBarStatus(cdT(res.serverRole === 'fast' ? 'bar.status.sentFast' : 'bar.status.sent'), 'ok');
      return res;
    }
    const err = res?.errorKey ? cdT(res.errorKey) : (res?.error || 'error');
    setBarStatus(cdT('bar.status.sendFailed', { error: err }), 'error');
    return res;
  }).catch((err) => {
    setBarStatus(cdT('bar.status.sendFailed', { error: err?.message || String(err) }), 'error');
    return { ok: false, error: String(err?.message || err) };
  });
}

function applyBarI18n(bar) {
  const start = bar.querySelector('[data-action="start"]');
  const end = bar.querySelector('[data-action="end"]');
  const clear = bar.querySelector('[data-action="clear"]');
  const hide = bar.querySelector('[data-action="hide"]');
  if (start) start.textContent = cdT('bar.start');
  if (end) end.textContent = cdT('bar.end');
  if (clear) clear.textContent = cdT('bar.cancel');
  if (hide) hide.title = cdT('bar.hideTitle');
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
    const clip = { start, end, includeInMerge: true };
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
  // Colours follow the popup's dark theme — the bar always sits on top of video.
  style.textContent = `
    #clip-direct-clip-bar {
      position: fixed;
      left: 12px;
      top: 12px;
      z-index: 2147483647;
      isolation: isolate;
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 248px;
      max-width: min(248px, calc(100vw - 24px));
      box-sizing: border-box;
      margin: 0;
      padding: 8px;
      border: 1px solid #33383f;
      border-radius: 8px;
      background: rgba(30, 33, 38, 0.94);
      color: #e8eaed;
      font: 12px/1.3 system-ui, sans-serif;
      text-align: left;
      box-shadow: 0 4px 20px rgba(0,0,0,0.45);
      pointer-events: auto;
      user-select: none;
    }
    #clip-direct-clip-bar * {
      box-sizing: border-box;
    }
    #clip-direct-clip-bar [hidden] {
      display: none !important;
    }
    #clip-direct-clip-bar button {
      cursor: pointer;
      margin: 0;
      border: 1px solid #464c55;
      border-radius: 6px;
      padding: 6px 10px;
      background: #272b31;
      color: #e8eaed;
      font: inherit;
      font-weight: 600;
      pointer-events: auto;
      position: relative;
      z-index: 1;
    }
    #clip-direct-clip-bar button:hover:not(:disabled) {
      border-color: #9aa2ad;
    }
    #clip-direct-clip-bar button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    #clip-direct-clip-bar button.clip-direct-next,
    #clip-direct-clip-bar button.clip-direct-primary {
      background: #4b83f0;
      border-color: #4b83f0;
      color: #fff;
    }
    #clip-direct-clip-bar button.clip-direct-next:hover:not(:disabled),
    #clip-direct-clip-bar button.clip-direct-primary:hover:not(:disabled) {
      background: #6595f3;
      border-color: #6595f3;
    }
    #clip-direct-clip-bar .clip-direct-head {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #clip-direct-clip-bar .clip-direct-title {
      flex: 1;
      color: #9aa2ad;
      font-size: 10px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #clip-direct-clip-bar .clip-direct-now {
      font-size: 14px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    #clip-direct-clip-bar button.clip-direct-hide {
      width: 20px;
      height: 20px;
      padding: 0;
      border: 0;
      background: none;
      color: #9aa2ad;
      font-size: 11px;
      font-weight: 400;
      line-height: 20px;
    }
    #clip-direct-clip-bar button.clip-direct-hide:hover {
      background: #33383f;
      color: #e8eaed;
    }
    #clip-direct-clip-bar .clip-direct-marks {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    #clip-direct-clip-bar .clip-direct-pending {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 7px;
      border-radius: 6px;
      background: #3a2d17;
      color: #e0a347;
    }
    #clip-direct-clip-bar .clip-direct-dot {
      flex-shrink: 0;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #e0a347;
      animation: clip-direct-pulse 1.4s ease-in-out infinite;
    }
    @keyframes clip-direct-pulse {
      50% { opacity: 0.3; }
    }
    #clip-direct-clip-bar .clip-direct-pending-text {
      flex: 1;
      min-width: 0;
      font-variant-numeric: tabular-nums;
    }
    #clip-direct-clip-bar button.clip-direct-link {
      padding: 0 2px;
      border: 0;
      background: none;
      color: inherit;
      font-size: 11px;
      font-weight: 400;
      text-decoration: underline;
    }
    #clip-direct-clip-bar .clip-direct-status {
      max-height: 7.5em;
      overflow-y: auto;
      padding: 5px 7px;
      border-radius: 6px;
      background: #272b31;
      color: #9aa2ad;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    #clip-direct-clip-bar .clip-direct-status[data-tone="busy"] {
      background: #1f2c44;
      color: #8fb2f7;
    }
    #clip-direct-clip-bar .clip-direct-status[data-tone="ok"] {
      background: #1a3125;
      color: #5fd08b;
    }
    #clip-direct-clip-bar .clip-direct-status[data-tone="warn"] {
      background: #3a2d17;
      color: #e0a347;
    }
    #clip-direct-clip-bar .clip-direct-status[data-tone="error"] {
      background: #3d1f20;
      color: #f06464;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function stopBarTick() {
  if (barTickId != null) {
    clearInterval(barTickId);
    barTickId = null;
  }
}

function ensureOverlay() {
  if (overlayRoot || !shouldShowBar()) return;
  injectOverlayStyles();
  const bar = document.createElement('div');
  bar.id = 'clip-direct-clip-bar';
  bar.innerHTML = `
    <div class="clip-direct-head">
      <span class="clip-direct-title">Clip-Direct</span>
      <span class="clip-direct-now" data-role="now">--:--</span>
      <button type="button" class="clip-direct-hide" data-action="hide" title="">✕</button>
    </div>
    <div class="clip-direct-marks">
      <button type="button" data-action="start"></button>
      <button type="button" data-action="end" disabled></button>
    </div>
    <div class="clip-direct-pending" data-role="pending" hidden>
      <span class="clip-direct-dot"></span>
      <span class="clip-direct-pending-text" data-role="pending-text"></span>
      <button type="button" class="clip-direct-link" data-action="clear"></button>
    </div>
    <button type="button" data-action="send"></button>
    <div class="clip-direct-status" data-role="status" hidden></div>
  `;
  applyBarI18n(bar);

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
    setBarStatus('');
    doMarkStart().catch(() => updateOverlayUiNow());
  });

  bindBarButton('[data-action="end"]', () => {
    setBarStatus('');
    doMarkEnd().catch(() => updateOverlayUiNow());
  });

  bindBarButton('[data-action="clear"]', () => {
    doClearPending().catch(() => updateOverlayUiNow());
  });

  bindBarButton('[data-action="send"]', () => sendFromBar());

  bindBarButton('[data-action="hide"]', () => {
    sessionBarHidden = true;
    stopBarTick();
    bar.remove();
    overlayRoot = null;
    storageLocalSet({ [BAR_HIDDEN_KEY]: true });
  });

  document.documentElement.appendChild(bar);
  overlayRoot = bar;
  barTickId = setInterval(tickBar, 500);
  syncOverlayState();
}

function syncOverlayState() {
  if (!overlayRoot) return;
  try {
    ensurePendingLoaded()
      .then(() => loadClipsForPage())
      .then((clips) => renderBar(clips))
      .catch(() => setBarStatus(cdT('bar.status.videoNotReady'), 'warn'));
  } catch {
    /* ignore — some players break DOM access */
  }
}

function initBar() {
  if (sessionBarHidden) return;
  const start = () => {
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
  };
  if (window.clipDirectI18nReady) {
    window.clipDirectI18nReady.then(start);
  } else {
    start();
  }
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

function failResponse(err) {
  return { ok: false, error: String(err?.message || err) };
}

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
      return false;
    }
    removeClipAt(Number(msg.index)).then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }

  if (msg?.action === 'replaceClips') {
    if (handleInvalidExtensionContext()) {
      sendResponse({ ok: false, error: 'context_invalidated', hint: 'reload_tab' });
      return true;
    }
    if (msg.pageKey && msg.pageKey !== storageKey() && !msg.force) {
      return false;
    }
    if (msg.force && !getActiveVideo()) {
      return false;
    }
    replaceClipsForPage(msg.clips).then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }

  if (msg?.action === 'setClipMergeIncluded') {
    if (handleInvalidExtensionContext()) {
      sendResponse({ ok: false, error: 'context_invalidated', hint: 'reload_tab' });
      return true;
    }
    if (msg.pageKey && msg.pageKey !== storageKey()) {
      return false;
    }
    setClipMergeIncludedAt(Number(msg.index), msg.includeInMerge).then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }

  if (msg?.action === 'updateClipTimes') {
    if (handleInvalidExtensionContext()) {
      sendResponse({ ok: false, error: 'context_invalidated', hint: 'reload_tab' });
      return true;
    }
    if (msg.pageKey && msg.pageKey !== storageKey()) {
      return false;
    }
    updateClipTimesAt(Number(msg.index), msg.start, msg.end).then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }

  // Popup RPC is answered only by the top frame
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
  if (msg?.action === 'getVideoMediaUrl') {
    getVideoMediaUrlFromPage().then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }
  if (msg?.action === 'getVideoState') {
    getVideoStateResponse().then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }
  if (msg?.action === 'markStart') {
    doMarkStart().then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }
  if (msg?.action === 'markEnd') {
    doMarkEnd().then(sendResponse, (err) => sendResponse(failResponse(err)));
    return true;
  }
  if (msg?.action === 'clearPending') {
    doClearPending().then(sendResponse, (err) => sendResponse(failResponse(err)));
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
  void reportStoredClipsOnce();
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
