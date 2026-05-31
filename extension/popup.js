import { applyI18n, initI18n, t } from './lib/i18n.js';
import { openClipDirectUi } from './lib/open-ui.js';
import { loadSettings, saveClipDraft } from './lib/storage.js';

const statusEl = document.getElementById('status');
const pageUrlEl = document.getElementById('pageUrl');
const pendingEl = document.getElementById('pending');
const clipListEl = document.getElementById('clipList');
const btnStart = document.getElementById('btnStart');
const btnEnd = document.getElementById('btnEnd');
const btnQueueEach = document.getElementById('btnQueueEach');
const btnQueueMerge = document.getElementById('btnQueueMerge');
const btnCancelPending = document.getElementById('btnCancelPending');
const btnShowBar = document.getElementById('btnShowBar');
const optionsLink = document.getElementById('optionsLink');
const streamSection = document.getElementById('streamSection');
const streamListEl = document.getElementById('streamList');
const streamClipListEl = document.getElementById('streamClipList');
const btnClearStreams = document.getElementById('btnClearStreams');
const btnOpenUi = document.getElementById('btnOpenUi');

let pageUrl = null;
let pageKey = null;
let clips = [];
let pendingStart = null;
let activeTabId = null;
let streams = [];
let streamTimer = null;
let tabClips = [];

optionsLink.href = chrome.runtime.getURL('options.html');
optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

btnOpenUi?.addEventListener('click', async () => {
  try {
    const settings = await loadSettings();
    await openClipDirectUi(settings.clipDirectBaseUrl);
    setStatus('popup.status.webUiOpened');
  } catch (err) {
    setStatus('popup.status.webUiFailed', { error: err?.message || err });
  }
});

function sendBg(action) {
  return chrome.runtime.sendMessage({ action });
}

async function getActiveTabId() {
  if (activeTabId != null) return activeTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  return activeTabId;
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
    return `${u.hostname}/…/${file}`;
  } catch {
    return url.length > 60 ? `${url.slice(0, 57)}…` : url;
  }
}

function refererLabel(stream) {
  const ref = stream.referer || stream.origin || '';
  if (!ref) return t('popup.referer.none');
  try {
    return t('popup.referer.label', { origin: new URL(ref).origin });
  } catch {
    return t('popup.referer.label', { origin: ref });
  }
}

async function sendStream(stream, withClips, button, mergeClips = false) {
  button.disabled = true;
  if (mergeClips) setStatus('popup.status.sendingMerge');
  else if (withClips) setStatus('popup.status.sendingCut');
  else setStatus('popup.status.sendingStream');
  const result = await chrome.runtime.sendMessage({
    action: 'queueStream',
    stream,
    pageUrl,
    clips: withClips ? tabClips : [],
    mergeClips,
  });
  if (result?.ok) {
    if (mergeClips) setStatus('popup.status.mergeQueued');
    else if (withClips) setStatus('popup.status.cutQueued');
    else setStatus('popup.status.streamQueued');
  } else {
    setStatus('popup.status.error', { error: result?.error || '?' });
    button.disabled = false;
  }
}

function renderTabClips() {
  if (!streamClipListEl) return;
  streamClipListEl.innerHTML = '';
  tabClips.forEach((clip, index) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${clip.start} → ${clip.end}`;
    li.appendChild(label);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.addEventListener('click', () => removeTabClip(index));
    li.appendChild(del);
    streamClipListEl.appendChild(li);
  });
}

async function removeTabClip(index) {
  const tabId = await getActiveTabId();
  const res = await chrome.runtime.sendMessage({ action: 'removeTabClip', tabId, index });
  if (res?.ok) {
    tabClips = Array.isArray(res.clips) ? res.clips : [];
    renderStreams();
  } else {
    setStatus('popup.status.error', { error: res?.error || '?' });
  }
}

function renderStreams() {
  renderTabClips();
  streamListEl.innerHTML = '';
  if (!streams.length && !tabClips.length) {
    streamSection.hidden = true;
    return;
  }
  streamSection.hidden = false;
  const hasCuts = tabClips.length > 0;
  streams.forEach((stream) => {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'stream-info';
    const kind = document.createElement('span');
    kind.className = `stream-kind ${stream.kind || ''}`;
    kind.textContent = stream.kind || 'media';
    const urlSpan = document.createElement('span');
    urlSpan.className = 'stream-url';
    urlSpan.textContent = shortenUrl(stream.url);
    urlSpan.title = stream.url;
    const refSpan = document.createElement('div');
    refSpan.className = 'stream-ref';
    refSpan.textContent = refererLabel(stream);
    info.appendChild(kind);
    info.appendChild(urlSpan);
    info.appendChild(refSpan);
    li.appendChild(info);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'stream-btns';
    if (hasCuts) {
      const cut = document.createElement('button');
      cut.type = 'button';
      cut.className = 'stream-send';
      cut.textContent = t('popup.stream.cutOne', { count: tabClips.length });
      cut.title = t('popup.stream.cutOneTitle');
      cut.addEventListener('click', () => sendStream(stream, true, cut, false));
      btnGroup.appendChild(cut);

      if (tabClips.length >= 2) {
        const merge = document.createElement('button');
        merge.type = 'button';
        merge.className = 'stream-merge';
        merge.textContent = t('popup.stream.merge', { count: tabClips.length });
        merge.title = t('popup.stream.mergeTitle');
        merge.addEventListener('click', () => sendStream(stream, true, merge, true));
        btnGroup.appendChild(merge);
      }

      const full = document.createElement('button');
      full.type = 'button';
      full.className = 'stream-full';
      full.textContent = t('popup.stream.full');
      full.title = t('popup.stream.fullTitle');
      full.addEventListener('click', () => sendStream(stream, false, full));
      btnGroup.appendChild(full);
    } else {
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'stream-send';
      send.textContent = t('popup.stream.send');
      send.addEventListener('click', () => sendStream(stream, false, send));
      btnGroup.appendChild(send);
    }
    li.appendChild(btnGroup);
    streamListEl.appendChild(li);
  });
}

async function refreshStreams() {
  const tabId = await getActiveTabId();
  const [streamRes, clipsRes] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getDetectedStreams', tabId }),
    chrome.runtime.sendMessage({ action: 'getTabClips', tabId }),
  ]);
  streams = Array.isArray(streamRes?.streams) ? streamRes.streams : [];
  tabClips = Array.isArray(clipsRes?.tabClips?.clips) ? clipsRes.tabClips.clips : [];
  renderStreams();
}

btnClearStreams?.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  await chrome.runtime.sendMessage({ action: 'clearDetectedStreams', tabId });
  streams = [];
  renderStreams();
});

function setStatus(keyOrText, params) {
  if (keyOrText.includes('.')) {
    statusEl.textContent = t(keyOrText, params);
  } else {
    statusEl.textContent = keyOrText;
  }
}

function renderClips() {
  clipListEl.innerHTML = '';
  clips.forEach((clip, index) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${clip.start} → ${clip.end}</span>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      clips.splice(index, 1);
      if (pageKey) await saveClipDraft(pageKey, clips);
      renderClips();
      updateButtons();
    });
    li.appendChild(del);
    clipListEl.appendChild(li);
  });
}

function updateButtons() {
  const hasClips = clips.length > 0;
  btnQueueEach.disabled = !pageUrl || !hasClips;
  btnQueueMerge.disabled = !pageUrl || clips.length < 2;
  if (btnCancelPending) {
    btnCancelPending.hidden = !pendingStart;
    btnCancelPending.disabled = !pendingStart;
  }
  if (btnEnd) btnEnd.disabled = !pendingStart;
  pendingEl.textContent = pendingStart ? t('popup.pendingLabel', { start: pendingStart }) : '';
}

function applyFromState(state) {
  if (state?.pageUrl) {
    pageUrl = state.pageUrl;
    pageUrlEl.hidden = false;
    pageUrlEl.textContent = pageUrl;
  }
  if (state?.pageKey) pageKey = state.pageKey;
  if (state?.pendingStart) pendingStart = state.pendingStart;
  else if (state && 'pendingStart' in state) pendingStart = null;
  if (Array.isArray(state?.clips)) clips = [...state.clips];
}

async function refresh() {
  const state = await sendBg('getVideoState');

  if (state?.error === 'context_invalidated' || state?.hint === 'reload_tab') {
    setStatus('popup.status.reloadExtension');
    btnStart.disabled = true;
    btnEnd.disabled = true;
    return;
  }

  applyFromState(state);

  if (state?.ok) {
    setStatus('popup.status.current', { time: state.formatted });
    btnStart.disabled = false;
  } else if (pendingStart) {
    setStatus('popup.status.pending');
    btnStart.disabled = false;
  } else if (clips.length) {
    setStatus('popup.status.clipsReady', { count: clips.length });
    btnStart.disabled = false;
  } else {
    setStatus(state?.error === 'no_video' ? 'popup.status.noVideo' : 'popup.status.connecting');
    btnStart.disabled = !state?.pageUrl;
  }

  renderClips();
  updateButtons();
}

btnStart?.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sendBg('markStart').then((res) => {
    if (res?.ok) applyFromState(res);
    else setStatus('popup.status.startFailed');
    updateButtons();
  });
});

btnEnd?.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sendBg('markEnd').then((res) => {
    if (res?.ok) {
      if (res.clip) clips.push(res.clip);
      pendingStart = null;
      applyFromState(res);
      if (pageKey) saveClipDraft(pageKey, clips);
    }
    renderClips();
    updateButtons();
  });
});

btnCancelPending?.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sendBg('clearPending').then(() => {
    pendingStart = null;
    updateButtons();
  });
});

btnShowBar?.addEventListener('click', () => {
  sendBg('showBar').then(() => setStatus('popup.status.barShown'));
});

btnQueueEach.addEventListener('click', () => sendQueue(false));
btnQueueMerge.addEventListener('click', () => sendQueue(true));

async function sendQueue(mergeClips) {
  const state = await sendBg('getVideoState');
  if (state?.pageUrl) pageUrl = state.pageUrl;
  if (Array.isArray(state?.clips) && state.clips.length) {
    clips = [...state.clips];
  }
  if (!pageUrl || !clips.length) {
    setStatus('popup.status.noClips');
    return;
  }
  setStatus('popup.status.sending');
  const result = await chrome.runtime.sendMessage({
    action: 'queueClips',
    pageUrl,
    clips,
    mergeClips,
  });
  if (result?.ok) {
    setStatus('popup.status.sent');
  } else if (result?.errorKey) {
    setStatus('popup.status.error', { error: t(result.errorKey) });
  } else {
    setStatus('popup.status.error', { error: result?.error || '?' });
  }
}

async function boot() {
  await initI18n();
  applyI18n();
  await refresh();
  refreshStreams();
  streamTimer = setInterval(refreshStreams, 1500);
}

boot();

window.addEventListener('unload', () => {
  if (streamTimer) clearInterval(streamTimer);
});
