import { applyI18n, initI18n, t } from './lib/i18n.js';
import { clipsForMerge, selectedClips } from './lib/jobs-client.js';
import { openClipDirectUi } from './lib/open-ui.js';
import { normalizeClockTime, parseClockTime } from './lib/format-time.js';
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
const btnCopyClips = document.getElementById('btnCopyClips');
const btnPasteClips = document.getElementById('btnPasteClips');
const clipClipboardHint = document.getElementById('clipClipboardHint');
const streamPasteHint = document.getElementById('streamPasteHint');

let pageUrl = null;
let pageKey = null;
let clips = [];
let pendingStart = null;
let activeTabId = null;
let streams = [];
let streamTimer = null;
let tabClips = [];
let tabPageKey = null;

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

function sendBg(action, extra = {}) {
  return chrome.runtime.sendMessage({ action, ...extra });
}

function activeClipSource() {
  if (clips.length) return clips;
  if (tabClips.length) return tabClips;
  return [];
}

function hostLabelFromUrl(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function updateClipboardUi(clipboard) {
  const count = clipboard?.clips?.length || 0;
  if (btnPasteClips) {
    btnPasteClips.disabled = count === 0;
  }
  if (clipClipboardHint) {
    if (count > 0) {
      clipClipboardHint.hidden = false;
      clipClipboardHint.textContent = t('popup.clip.clipboardReady', {
        count,
        host: clipboard.fromHost || t('popup.clip.clipboardUnknownHost'),
      });
    } else {
      clipClipboardHint.hidden = true;
      clipClipboardHint.textContent = '';
    }
  }
  updateStreamPasteHint(clipboard);
}

function updateStreamPasteHint(clipboard) {
  if (!streamPasteHint) return;
  const cbCount = clipboard?.clips?.length || 0;
  const hasStreams = streams.length > 0;
  const hasLocalClips = activeClipSource().length > 0;
  if (hasStreams && !hasLocalClips && cbCount > 0) {
    streamPasteHint.hidden = false;
    streamPasteHint.textContent = t('popup.clip.pasteForStream', { count: cbCount });
  } else {
    streamPasteHint.hidden = true;
    streamPasteHint.textContent = '';
  }
}

async function refreshClipboardUi() {
  const res = await sendBg('getClipClipboard');
  updateClipboardUi(res?.clipboard || null);
}

async function copyClipsToClipboard() {
  const source = activeClipSource();
  if (!source.length) {
    setStatus('popup.status.noClips');
    return;
  }
  const host = hostLabelFromUrl(pageUrl) || hostLabelFromUrl(tabPageKey);
  const res = await sendBg('copyClipsToClipboard', {
    clips: source,
    meta: { fromHost: host, fromPage: pageUrl || '' },
  });
  if (res?.ok) {
    updateClipboardUi(res.clipboard);
    setStatus('popup.status.clipsCopied', { count: source.length });
  } else {
    setStatus('popup.status.error', { error: res?.error || '?' });
  }
}

async function pasteClipsFromClipboard() {
  const cbRes = await sendBg('getClipClipboard');
  const clipboard = cbRes?.clipboard;
  if (!clipboard?.clips?.length) {
    setStatus('popup.status.clipboardEmpty');
    return;
  }
  const tabId = await getActiveTabId();
  const res = await sendBg('importTabClips', {
    tabId,
    clips: clipboard.clips,
  });
  if (res?.ok) {
    syncClipsFromResult(res);
    renderClips();
    renderStreams();
    updateButtons();
    setStatus('popup.status.clipsPasted', { count: res.clips.length });
  } else {
    setStatus('popup.status.error', { error: res?.error || 'paste_failed' });
  }
}

btnCopyClips?.addEventListener('click', () => {
  void copyClipsToClipboard();
});

btnPasteClips?.addEventListener('click', () => {
  void pasteClipsFromClipboard();
});

function syncClipsFromResult(res) {
  if (!res?.ok || !Array.isArray(res.clips)) return;
  clips = [...res.clips];
  tabClips = [...res.clips];
  const pk = res.pageKey || tabPageKey || pageKey;
  if (pk) {
    if (res.pageKey) tabPageKey = res.pageKey;
    saveClipDraft(pk, clips);
  }
}

function clipTimeErrorMessage(error) {
  if (error === 'invalid_time') return t('popup.clip.invalidTime');
  if (error === 'end_before_start') return t('popup.clip.endBeforeStart');
  return error || '?';
}

function buildClipRow(clip, index, { onToggleMerge, onRemove, onUpdateTimes }) {
  const li = document.createElement('li');
  if (clip.includeInMerge === false) {
    li.classList.add('clip-merge-off');
  }

  const row = document.createElement('div');
  row.className = 'clip-row';

  const mergeCb = document.createElement('input');
  mergeCb.type = 'checkbox';
  mergeCb.className = 'clip-merge-cb';
  mergeCb.checked = clip.includeInMerge !== false;
  mergeCb.title = t('popup.clip.includeMergeTitle');
  mergeCb.addEventListener('change', () => onToggleMerge(index, mergeCb.checked));

  const times = document.createElement('div');
  times.className = 'clip-times';

  const startInput = document.createElement('input');
  startInput.type = 'text';
  startInput.className = 'clip-time-input';
  startInput.value = clip.start || '';
  startInput.title = t('popup.clip.startTitle');
  startInput.setAttribute('aria-label', t('popup.clip.startTitle'));
  startInput.spellcheck = false;

  const sep = document.createElement('span');
  sep.className = 'clip-time-sep';
  sep.textContent = '→';

  const endInput = document.createElement('input');
  endInput.type = 'text';
  endInput.className = 'clip-time-input';
  endInput.value = clip.end || '';
  endInput.title = t('popup.clip.endTitle');
  endInput.setAttribute('aria-label', t('popup.clip.endTitle'));
  endInput.spellcheck = false;

  function resetInputs() {
    startInput.value = clip.start || '';
    endInput.value = clip.end || '';
    startInput.classList.remove('clip-time-invalid');
    endInput.classList.remove('clip-time-invalid');
  }

  async function commitTimes() {
    const res = await onUpdateTimes(index, startInput.value, endInput.value);
    if (res?.ok) {
      clip.start = res.clips[index]?.start ?? startInput.value;
      clip.end = res.clips[index]?.end ?? endInput.value;
      resetInputs();
      return;
    }
    startInput.classList.add('clip-time-invalid');
    endInput.classList.add('clip-time-invalid');
    setStatus('popup.status.error', { error: clipTimeErrorMessage(res?.error) });
  }

  function bindTimeInput(input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        resetInputs();
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      const normStart = normalizeClockTime(startInput.value);
      const normEnd = normalizeClockTime(endInput.value);
      if (normStart === clip.start && normEnd === clip.end) {
        resetInputs();
        return;
      }
      void commitTimes();
    });
  }

  bindTimeInput(startInput);
  bindTimeInput(endInput);

  times.appendChild(startInput);
  times.appendChild(sep);
  times.appendChild(endInput);

  row.appendChild(mergeCb);
  row.appendChild(times);
  li.appendChild(row);

  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '×';
  del.addEventListener('click', () => onRemove(index));
  li.appendChild(del);
  return li;
}

async function updateTabClipTimes(index, start, end) {
  const tabId = await getActiveTabId();
  const res = await chrome.runtime.sendMessage({
    action: 'updateTabClipTimes',
    tabId,
    pageKey: tabPageKey || pageKey,
    index,
    start,
    end,
  });
  if (res?.ok) {
    syncClipsFromResult(res);
    renderClips();
    renderStreams();
    updateButtons();
  } else {
    setStatus('popup.status.error', { error: clipTimeErrorMessage(res?.error) });
  }
  return res;
}

async function setClipMergeIncluded(index, includeInMerge) {
  const tabId = await getActiveTabId();
  const res = await chrome.runtime.sendMessage({
    action: 'setClipMergeIncluded',
    tabId,
    pageKey: tabPageKey || pageKey,
    index,
    includeInMerge,
  });
  if (res?.ok) {
    syncClipsFromResult(res);
    renderClips();
    renderStreams();
    updateButtons();
  } else {
    setStatus('popup.status.error', { error: res?.error || '?' });
  }
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

  let clipPayload = [];
  if (withClips) {
    const source = await clipsReadyToSend();
    clipPayload = mergeClips ? clipsForMerge(source) : selectedClips(source);
    if (mergeClips && clipPayload.length < 2) {
      setStatus('popup.status.mergeNeedTwo');
      button.disabled = false;
      return;
    }
    if (!clipPayload.length) {
      setStatus('popup.status.noClips');
      button.disabled = false;
      return;
    }
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'queueStream',
      stream,
      pageUrl,
      clips: clipPayload,
      mergeClips,
    });
    if (result?.ok) {
      if (mergeClips) setStatus('popup.status.mergeQueued');
      else if (withClips) setStatus('popup.status.cutQueued');
      else setStatus('popup.status.streamQueued');
    } else if (result?.errorKey) {
      setStatus('popup.status.error', { error: t(result.errorKey) });
    } else {
      setStatus('popup.status.error', { error: result?.error || '?' });
    }
  } finally {
    button.disabled = false;
  }
}

function renderTabClips() {
  if (!streamClipListEl) return;
  streamClipListEl.innerHTML = '';
  tabClips.forEach((clip, index) => {
    streamClipListEl.appendChild(buildClipRow(clip, index, {
      onToggleMerge: (i, checked) => setClipMergeIncluded(i, checked),
      onRemove: (i) => removeTabClip(i),
      onUpdateTimes: (i, start, end) => updateTabClipTimes(i, start, end),
    }));
  });
}

async function removeTabClip(index) {
  const tabId = await getActiveTabId();
  const res = await chrome.runtime.sendMessage({
    action: 'removeTabClip',
    tabId,
    pageKey: tabPageKey || pageKey,
    index,
  });
  if (res?.ok) {
    syncClipsFromResult(res);
    renderClips();
    renderStreams();
    updateButtons();
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
  const mergeCount = clipsForMerge(tabClips).length;
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
      const selectedCount = selectedClips(tabClips).length;
      if (selectedCount > 0) {
        const cut = document.createElement('button');
        cut.type = 'button';
        cut.className = 'stream-send';
        cut.textContent = t('popup.stream.cutOne', { count: selectedCount });
        cut.title = t('popup.stream.cutOneTitle');
        cut.addEventListener('click', () => sendStream(stream, true, cut, false));
        btnGroup.appendChild(cut);
      }

      if (mergeCount >= 2) {
        const merge = document.createElement('button');
        merge.type = 'button';
        merge.className = 'stream-merge';
        merge.textContent = t('popup.stream.merge', { count: mergeCount });
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

function isEditingClipTime() {
  return document.activeElement?.classList?.contains('clip-time-input');
}

async function refreshStreams() {
  const tabId = await getActiveTabId();
  const [streamRes, clipsRes] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getDetectedStreams', tabId }),
    chrome.runtime.sendMessage({ action: 'getTabClips', tabId }),
  ]);
  streams = Array.isArray(streamRes?.streams) ? streamRes.streams : [];
  const nextClips = Array.isArray(clipsRes?.tabClips?.clips) ? clipsRes.tabClips.clips : [];
  tabPageKey = clipsRes?.tabClips?.pageKey || null;
  const cbRes = await sendBg('getClipClipboard');
  updateClipboardUi(cbRes?.clipboard || null);
  if (isEditingClipTime()) {
    return;
  }
  tabClips = nextClips;
  if (tabClips.length) {
    clips = [...tabClips];
  }
  renderClips();
  renderStreams();
  updateButtons();
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
    clipListEl.appendChild(buildClipRow(clip, index, {
      onToggleMerge: (i, checked) => setClipMergeIncluded(i, checked),
      onRemove: (i) => removeTabClip(i),
      onUpdateTimes: (i, start, end) => updateTabClipTimes(i, start, end),
    }));
  });
}

function updateButtons() {
  const hasAnyClips = activeClipSource().length > 0;
  const selectedCount = selectedClips(activeClipSource()).length;
  const mergeCount = clipsForMerge(activeClipSource()).length;
  btnQueueEach.disabled = !pageUrl || selectedCount < 1;
  btnQueueMerge.disabled = !pageUrl || mergeCount < 2;
  if (btnCopyClips) {
    btnCopyClips.disabled = !hasAnyClips;
  }
  if (btnCancelPending) {
    btnCancelPending.classList.toggle('is-visible', !!pendingStart);
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

function applyVisibleTimes(source) {
  const next = (source || []).map((c) => ({ ...c }));
  for (const list of [clipListEl, streamClipListEl]) {
    if (!list) continue;
    list.querySelectorAll(':scope > li').forEach((li, index) => {
      const inputs = li.querySelectorAll('.clip-time-input');
      const orig = source[index];
      if (inputs.length < 2 || !orig) return;
      const start = normalizeClockTime(inputs[0].value);
      const end = normalizeClockTime(inputs[1].value);
      if (!start || !end || parseClockTime(end) <= parseClockTime(start)) return;
      if (start === orig.start && end === orig.end) return;
      next[index] = { ...next[index], start, end };
    });
  }
  return next;
}

async function persistTimeEdits(updated, previous) {
  const tasks = [];
  updated.forEach((clip, index) => {
    const prev = previous[index];
    if (!prev || (clip.start === prev.start && clip.end === prev.end)) return;
    tasks.push(updateTabClipTimes(index, clip.start, clip.end));
  });
  if (tasks.length) await Promise.all(tasks);
}

/** What the inputs show right now — not a stale copy from before the last blur. */
async function clipsReadyToSend() {
  const previous = activeClipSource().map((c) => ({ ...c }));
  const updated = applyVisibleTimes(previous);
  await persistTimeEdits(updated, previous);
  clips = updated.map((c) => ({ ...c }));
  tabClips = clips.map((c) => ({ ...c }));
  return clips;
}

async function sendQueue(mergeClips) {
  const tabId = await getActiveTabId();
  const [clipsRes, state] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getTabClips', tabId }),
    sendBg('getVideoState'),
  ]);
  if (clipsRes?.tabClips?.clips?.length) {
    tabClips = [...clipsRes.tabClips.clips];
    clips = [...tabClips];
  } else if (Array.isArray(state?.clips) && state.clips.length) {
    clips = [...state.clips];
  }
  if (state?.pageUrl) pageUrl = state.pageUrl;
  const source = await clipsReadyToSend();
  const payload = mergeClips ? clipsForMerge(source) : selectedClips(source);
  if (!pageUrl || !payload.length) {
    setStatus('popup.status.noClips');
    return;
  }
  if (mergeClips && payload.length < 2) {
    setStatus('popup.status.mergeNeedTwo');
    return;
  }
  setStatus('popup.status.sending');
  const result = await chrome.runtime.sendMessage({
    action: 'queueClips',
    pageUrl,
    clips: payload,
    mergeClips,
  });  if (result?.ok) {
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
  await refreshClipboardUi();
  await refresh();
  await refreshStreams();
  streamTimer = setInterval(refreshStreams, 1500);
}

boot();

window.addEventListener('unload', () => {
  if (streamTimer) clearInterval(streamTimer);
});
