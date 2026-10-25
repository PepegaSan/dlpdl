import { applyI18n, initI18n, t } from './lib/i18n.js';
import { clipsForMerge, selectedClips } from './lib/jobs-client.js';
import { openClipDirectUi } from './lib/open-ui.js';
import { formatClockTime, normalizeClockTime, parseClockTime } from './lib/format-time.js';
import { loadSettings, saveClipDraft } from './lib/storage.js';
const statusEl = document.getElementById('status');
const pageUrlEl = document.getElementById('pageUrl');
const nowTimeEl = document.getElementById('nowTime');
const pendingRowEl = document.getElementById('pendingRow');
const pendingEl = document.getElementById('pending');
const hintTopEl = document.getElementById('hintTop');
const clipListEl = document.getElementById('clipList');
const clipCountEl = document.getElementById('clipCount');
const clipEmptyEl = document.getElementById('clipEmpty');
const clipSummaryEl = document.getElementById('clipSummary');
const clipTransferEl = document.querySelector('.clip-transfer');
const actionsEl = document.getElementById('actions');
const btnStart = document.getElementById('btnStart');
const btnEnd = document.getElementById('btnEnd');
const btnQueueEach = document.getElementById('btnQueueEach');
const btnQueueMerge = document.getElementById('btnQueueMerge');
const btnCancelPending = document.getElementById('btnCancelPending');
const btnShowBar = document.getElementById('btnShowBar');
const btnToggleAll = document.getElementById('btnToggleAll');
const optionsLink = document.getElementById('optionsLink');
const streamSection = document.getElementById('streamSection');
const streamCountEl = document.getElementById('streamCount');
const streamListEl = document.getElementById('streamList');
const btnClearStreams = document.getElementById('btnClearStreams');
const btnOpenUi = document.getElementById('btnOpenUi');
const btnCopyClips = document.getElementById('btnCopyClips');
const btnPasteClips = document.getElementById('btnPasteClips');
const clipClipboardHint = document.getElementById('clipClipboardHint');
const streamPasteHint = document.getElementById('streamPasteHint');

const NO_TIME = '--:--';
const OK_STATUS = new Set(['sent', 'mergeQueued', 'cutQueued', 'streamQueued', 'clipsCopied', 'clipsPasted', 'webUiOpened', 'barShown']);
const BUSY_STATUS = new Set(['connecting', 'sending', 'sendingMerge', 'sendingCut', 'sendingStream']);
const WARN_STATUS = new Set(['noVideo', 'reloadExtension', 'noClips', 'mergeNeedTwo', 'clipboardEmpty']);

let pageUrl = null;
let pageKey = null;
let clips = [];
let pendingStart = null;
let nowSeconds = null;
let activeTabId = null;
let streams = [];
let pollTimer = null;
let polling = false;
let statusKey = '';
let statusTimer = null;
let clipboardCount = 0;
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

function setPageUrl(url) {
  if (!url) return;
  pageUrl = url;
  pageUrlEl.hidden = false;
  pageUrlEl.textContent = hostLabelFromUrl(url) || url;
  pageUrlEl.title = url;
}

function updateClipboardUi(clipboard) {
  const count = clipboard?.clips?.length || 0;
  clipboardCount = count;
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
  updateButtons();
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

function isSelected(clip) {
  return clip.includeInMerge !== false;
}

/** Start/end in seconds, or null when the clip has no usable range. */
function clipRange(clip) {
  const start = parseClockTime(clip.start);
  const end = parseClockTime(clip.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** Index of another selected clip whose range overlaps clip `index`, or -1. */
function overlappingClip(list, ranges, index) {
  const range = ranges[index];
  if (!range || !isSelected(list[index])) return -1;
  return list.findIndex((other, j) => (
    j !== index
    && isSelected(other)
    && ranges[j]
    && ranges[j].start < range.end
    && range.start < ranges[j].end
  ));
}

function buildClipRow(clip, index, { range, overlapWith }) {
  const li = document.createElement('li');
  li.classList.toggle('clip-off', !isSelected(clip));
  li.classList.toggle('clip-bad', !range);
  li.classList.toggle('clip-overlap', !!range && overlapWith >= 0);

  const pick = document.createElement('label');
  pick.className = 'clip-pick';
  pick.title = t('popup.clip.selectTitle');
  const selectCb = document.createElement('input');
  selectCb.type = 'checkbox';
  selectCb.checked = isSelected(clip);
  selectCb.addEventListener('change', () => setClipMergeIncluded(index, selectCb.checked));
  const num = document.createElement('span');
  num.className = 'clip-index';
  num.textContent = `#${index + 1}`;
  pick.appendChild(selectCb);
  pick.appendChild(num);

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
    const res = await updateTabClipTimes(index, startInput.value, endInput.value);
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

  const dur = document.createElement('span');
  dur.className = 'clip-dur';
  if (!range) {
    dur.textContent = '!';
    dur.title = t('popup.clip.endBeforeStart');
  } else {
    dur.textContent = formatClockTime(range.end - range.start);
    dur.title = overlapWith >= 0
      ? t('popup.clip.overlap', { other: overlapWith + 1 })
      : t('popup.clip.durationTitle');
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'clip-del';
  del.textContent = '×';
  del.title = t('popup.clip.removeTitle');
  del.addEventListener('click', () => removeTabClip(index));

  li.appendChild(pick);
  li.appendChild(times);
  li.appendChild(dur);
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

/** One message per clip that differs; sequential so the session updates don't race. */
async function setAllSelected(checked) {
  const source = activeClipSource().map((c) => ({ ...c }));
  for (let i = 0; i < source.length; i += 1) {
    if (isSelected(source[i]) !== checked) {
      await setClipMergeIncluded(i, checked);
    }
  }
}

btnToggleAll?.addEventListener('click', () => {
  const source = activeClipSource();
  void setAllSelected(!source.every(isSelected));
});

async function getActiveTabId() {
  if (activeTabId != null) return activeTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  return activeTabId;
}

function streamParts(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
    return { host: u.hostname, file };
  } catch {
    return { host: '', file: url };
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

function streamButton(className, label, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ${className}`;
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

function renderStreams() {
  streamListEl.innerHTML = '';
  streamSection.hidden = !streams.length;
  streamCountEl.textContent = String(streams.length);
  const source = activeClipSource();
  const selectedCount = selectedClips(source).length;
  const mergeCount = clipsForMerge(source).length;
  streams.forEach((stream) => {
    const li = document.createElement('li');
    const { host, file } = streamParts(stream.url);

    const head = document.createElement('div');
    head.className = 'stream-head';
    const kind = document.createElement('span');
    kind.className = `stream-kind ${stream.kind || ''}`;
    kind.textContent = stream.kind || 'media';
    const fileSpan = document.createElement('span');
    fileSpan.className = 'stream-file';
    fileSpan.textContent = file;
    fileSpan.title = stream.url;
    head.appendChild(kind);
    head.appendChild(fileSpan);

    const meta = document.createElement('div');
    meta.className = 'stream-meta';
    meta.textContent = host ? `${host} · ${refererLabel(stream)}` : refererLabel(stream);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'stream-btns';
    if (source.length) {
      if (selectedCount > 0) {
        btnGroup.appendChild(streamButton(
          'btn-primary',
          t('popup.stream.cutOne', { count: selectedCount }),
          t('popup.stream.cutOneTitle'),
          (btn) => sendStream(stream, true, btn, false),
        ));
      }
      if (mergeCount >= 2) {
        btnGroup.appendChild(streamButton(
          'btn-merge',
          t('popup.stream.merge', { count: mergeCount }),
          t('popup.stream.mergeTitle'),
          (btn) => sendStream(stream, true, btn, true),
        ));
      }
      btnGroup.appendChild(streamButton(
        '',
        t('popup.stream.full'),
        t('popup.stream.fullTitle'),
        (btn) => sendStream(stream, false, btn),
      ));
    } else {
      btnGroup.appendChild(streamButton(
        'btn-primary',
        t('popup.stream.send'),
        t('popup.stream.fullTitle'),
        (btn) => sendStream(stream, false, btn),
      ));
    }

    li.appendChild(head);
    li.appendChild(meta);
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
  const nextStreams = Array.isArray(streamRes?.streams) ? streamRes.streams : [];
  const nextClips = Array.isArray(clipsRes?.tabClips?.clips) ? clipsRes.tabClips.clips : [];
  tabPageKey = clipsRes?.tabClips?.pageKey || null;
  const cbRes = await sendBg('getClipClipboard');
  const clipboard = cbRes?.clipboard || null;
  if (isEditingClipTime()) {
    updateClipboardUi(clipboard);
    return;
  }
  // Rebuilding the lists every poll would steal hover/focus from their buttons.
  const changed = JSON.stringify(nextStreams) !== JSON.stringify(streams)
    || JSON.stringify(nextClips) !== JSON.stringify(tabClips);
  streams = nextStreams;
  tabClips = nextClips;
  if (tabClips.length) {
    clips = [...tabClips];
  }
  if (changed) {
    renderClips();
    renderStreams();
  }
  updateClipboardUi(clipboard);
  if (statusKey === 'popup.status.noVideo' && (streams.length || activeClipSource().length)) {
    // Embed pages: the player lives in an iframe, so the top frame has no video of its own.
    clearStatus();
  }
}

/** Keeps the "now" clock and a start set via shortcut in sync while the popup is open. */
async function refreshLive() {
  const state = await sendBg('getVideoState');
  if (!state || state.error === 'context_invalidated' || state.hint === 'reload_tab') return;
  setPageUrl(state.pageUrl);
  if ('pendingStart' in state) pendingStart = state.pendingStart || null;
  nowSeconds = state.ok && Number.isFinite(state.currentTime) ? state.currentTime : null;
  if (state.ok) {
    btnStart.disabled = false;
    if (statusKey === 'popup.status.noVideo' || statusKey === 'popup.status.connecting') {
      clearStatus();
    }
  }
  updateButtons();
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await Promise.all([refreshLive(), refreshStreams()]);
  } finally {
    polling = false;
  }
}

btnClearStreams?.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  await chrome.runtime.sendMessage({ action: 'clearDetectedStreams', tabId });
  streams = [];
  renderStreams();
});

function statusTone(key) {
  const name = key.replace(/^popup\.status\./, '');
  if (OK_STATUS.has(name)) return 'ok';
  if (BUSY_STATUS.has(name)) return 'busy';
  if (WARN_STATUS.has(name)) return 'warn';
  return 'error';
}

function setStatus(keyOrText, params) {
  clearTimeout(statusTimer);
  statusKey = keyOrText;
  if (keyOrText.includes('.')) {
    statusEl.textContent = t(keyOrText, params);
  } else {
    statusEl.textContent = keyOrText;
  }
  const tone = statusTone(keyOrText);
  statusEl.className = `status tone-${tone}`;
  statusEl.hidden = false;
  if (tone === 'ok') {
    statusTimer = setTimeout(clearStatus, 5000);
  }
}

function clearStatus() {
  clearTimeout(statusTimer);
  statusKey = '';
  statusEl.hidden = true;
  statusEl.textContent = '';
}

function renderClips() {
  clipListEl.innerHTML = '';
  const source = activeClipSource();
  const ranges = source.map(clipRange);
  source.forEach((clip, index) => {
    clipListEl.appendChild(buildClipRow(clip, index, {
      range: ranges[index],
      overlapWith: overlappingClip(source, ranges, index),
    }));
  });
}

function updateClipSummary(source) {
  // Same list the send buttons use, so the numbers match what actually goes out.
  const sendable = selectedClips(source);
  const invalid = source.filter((clip) => !clipRange(clip)).length;
  const total = sendable.reduce((sum, clip) => {
    const range = clipRange(clip);
    return range ? sum + (range.end - range.start) : sum;
  }, 0);
  clipCountEl.hidden = !source.length;
  clipCountEl.textContent = String(source.length);
  clipEmptyEl.hidden = source.length > 0;
  clipSummaryEl.hidden = !source.length;
  let summary = t('popup.clip.summary', {
    selected: sendable.length,
    total: source.length,
    duration: formatClockTime(total),
  });
  if (invalid) summary += ` · ${t('popup.clip.summaryInvalid', { count: invalid })}`;
  clipSummaryEl.textContent = summary;
  btnToggleAll.hidden = source.length < 2;
  btnToggleAll.textContent = source.every(isSelected)
    ? t('popup.selectNone')
    : t('popup.selectAll');
}

function updatePending() {
  pendingRowEl.hidden = !pendingStart;
  if (!pendingStart) return;
  const elapsed = nowSeconds != null ? nowSeconds - parseClockTime(pendingStart) : NaN;
  pendingEl.textContent = elapsed >= 1
    ? t('popup.pendingRunning', { start: pendingStart, elapsed: formatClockTime(elapsed) })
    : t('popup.pendingLabel', { start: pendingStart });
}

function updateButtons() {
  const source = activeClipSource();
  const selectedCount = selectedClips(source).length;
  const mergeCount = clipsForMerge(source).length;
  btnQueueEach.disabled = !pageUrl || selectedCount < 1;
  btnQueueMerge.disabled = !pageUrl || mergeCount < 2;
  btnQueueEach.textContent = t('popup.queueEach', { count: selectedCount });
  btnQueueMerge.textContent = t('popup.queueMerge', { count: mergeCount });
  actionsEl.hidden = !source.length;
  if (btnCopyClips) {
    btnCopyClips.disabled = !source.length;
  }
  clipTransferEl.hidden = !source.length && !clipboardCount;
  // Embed pages: no video in the top frame, so the page URL rarely works — favour the stream buttons.
  actionsEl.classList.toggle('is-muted', nowSeconds == null && streams.length > 0);
  if (btnEnd) btnEnd.disabled = !pendingStart;
  // Highlight whichever marker the user needs next.
  btnStart.classList.toggle('is-next', !pendingStart && !btnStart.disabled && nowSeconds != null);
  btnEnd.classList.toggle('is-next', !!pendingStart);
  nowTimeEl.textContent = nowSeconds != null ? formatClockTime(nowSeconds) : NO_TIME;
  hintTopEl.hidden = source.length > 0 || !!pendingStart;
  updatePending();
  updateClipSummary(source);
}

function applyFromState(state) {
  setPageUrl(state?.pageUrl);
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
  nowSeconds = state?.ok && Number.isFinite(state.currentTime) ? state.currentTime : null;

  if (state?.ok || pendingStart || clips.length) {
    btnStart.disabled = false;
  } else {
    setStatus(state?.error === 'no_video' ? 'popup.status.noVideo' : 'popup.status.connecting');
    btnStart.disabled = !state?.pageUrl;
  }

  renderClips();
  updateButtons();
}

async function showShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const byName = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
    for (const [id, name] of [['kbdStart', 'mark-start'], ['kbdEnd', 'mark-end']]) {
      const el = document.getElementById(id);
      el.textContent = byName[name] || '';
      el.hidden = !byName[name];
    }
  } catch {
    /* shortcuts are only a hint */
  }
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
  clipListEl.querySelectorAll(':scope > li').forEach((li, index) => {
    const inputs = li.querySelectorAll('.clip-time-input');
    const orig = source[index];
    if (inputs.length < 2 || !orig) return;
    const start = normalizeClockTime(inputs[0].value);
    const end = normalizeClockTime(inputs[1].value);
    if (!start || !end || parseClockTime(end) <= parseClockTime(start)) return;
    if (start === orig.start && end === orig.end) return;
    next[index] = { ...next[index], start, end };
  });
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
  setPageUrl(state?.pageUrl);
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
  void showShortcuts();
  await refreshClipboardUi();
  await refresh();
  await refreshStreams();
  pollTimer = setInterval(poll, 1000);
}

boot();

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});
