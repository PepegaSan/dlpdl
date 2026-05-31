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
    setStatus('Web-UI geöffnet — Fortschritt & PC-Download dort.');
  } catch (err) {
    setStatus(`Web-UI konnte nicht geöffnet werden: ${err?.message || err}`);
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
  if (!ref) return 'kein Referer erkannt';
  try {
    return `Referer: ${new URL(ref).origin}`;
  } catch {
    return `Referer: ${ref}`;
  }
}

async function sendStream(stream, withClips, button, mergeClips = false) {
  button.disabled = true;
  if (mergeClips) setStatus('Sende Stream als Zusammenschnitt…');
  else setStatus(withClips ? 'Sende Stream mit Schnitt…' : 'Sende Stream…');
  const result = await chrome.runtime.sendMessage({
    action: 'queueStream',
    stream,
    pageUrl,
    clips: withClips ? tabClips : [],
    mergeClips,
  });
  if (result?.ok) {
    if (mergeClips) setStatus('Zusammenschnitt wird erstellt…');
    else setStatus(withClips ? 'Stream + Schnitt gesendet.' : 'Stream gesendet.');
  } else {
    setStatus(`Fehler: ${result?.error || '?'}`);
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
    del.title = 'Abschnitt aus der Auswahl entfernen';
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
    setStatus(`Konnte Abschnitt nicht entfernen: ${res?.error || '?'}`);
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
      cut.textContent = `Mit Schnitt (${tabClips.length})`;
      cut.title = tabClips.length === 1
        ? 'Einen markierten Abschnitt als Datei (gleicher Pfad wie Zusammenfügen)'
        : 'Jeden markierten Abschnitt als eigene Datei';
      cut.addEventListener('click', () => sendStream(stream, true, cut, false));
      btnGroup.appendChild(cut);

      if (tabClips.length >= 2) {
        const merge = document.createElement('button');
        merge.type = 'button';
        merge.className = 'stream-merge';
        merge.textContent = `Zusammenfügen (${tabClips.length})`;
        merge.title = 'Alle markierten Abschnitte zu einer Datei zusammenfügen';
        merge.addEventListener('click', () => sendStream(stream, true, merge, true));
        btnGroup.appendChild(merge);
      }

      const full = document.createElement('button');
      full.type = 'button';
      full.className = 'stream-full';
      full.textContent = 'Ganzes';
      full.addEventListener('click', () => sendStream(stream, false, full));
      btnGroup.appendChild(full);
    } else {
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'stream-send';
      send.textContent = 'Senden';
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

function setStatus(text) {
  statusEl.textContent = text;
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
  pendingEl.textContent = pendingStart ? `Start: ${pendingStart}` : '';
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
    setStatus('Clip-Direct wurde aktualisiert — diese Seite einmal neu laden (F5).');
    btnStart.disabled = true;
    btnEnd.disabled = true;
    return;
  }

  applyFromState(state);

  if (state?.ok) {
    setStatus(`Aktuell: ${state.formatted} — oder Leiste auf der Seite`);
    btnStart.disabled = false;
  } else if (pendingStart) {
    setStatus('Start gespeichert — Ende auf der Seiten-Leiste oder hier');
    btnStart.disabled = false;
  } else if (clips.length) {
    setStatus(`${clips.length} Clip(s) — unten senden`);
    btnStart.disabled = false;
  } else {
    setStatus(state?.error === 'no_video' ? 'Kein Video — Seite neu laden' : 'Verbinde…');
    btnStart.disabled = !state?.pageUrl;
  }

  renderClips();
  updateButtons();
}

btnStart?.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sendBg('markStart').then((res) => {
    if (res?.ok) applyFromState(res);
    else setStatus('Start fehlgeschlagen — Leiste unten rechts auf der Seite nutzen');
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
  sendBg('showBar').then(() => setStatus('Leiste auf der Seite sollte sichtbar sein'));
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
    setStatus('Keine Clips — zuerst Start/Ende setzen');
    return;
  }
  setStatus('Sende…');
  const result = await chrome.runtime.sendMessage({
    action: 'queueClips',
    pageUrl,
    clips,
    mergeClips,
  });
  setStatus(result?.ok ? 'Gesendet — im Web-UI Fortschritt/Download.' : `Fehler: ${result?.error || '?'}`);
}

refresh();
refreshStreams();
streamTimer = setInterval(refreshStreams, 1500);
window.addEventListener('unload', () => {
  if (streamTimer) clearInterval(streamTimer);
});
