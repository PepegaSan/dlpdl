const AUTO_DOWNLOAD_KEY = 'clipDirectAutoDownload';
const AUTO_CLAIMED_KEY = 'clipDirectAutoClaimed';

function autoDownloadEnabled() {
  return localStorage.getItem(AUTO_DOWNLOAD_KEY) !== 'false';
}

function setAutoDownload(on) {
  localStorage.setItem(AUTO_DOWNLOAD_KEY, on ? 'true' : 'false');
}

function loadIdSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set();
  }
}

function saveIdSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

/** Sofort in localStorage — wichtig bei mehreren Tabs. */
function tryClaimAutoDownload(jobId) {
  const claimed = loadIdSet(AUTO_CLAIMED_KEY);
  if (claimed.has(jobId)) return false;
  claimed.add(jobId);
  saveIdSet(AUTO_CLAIMED_KEY, claimed);
  return true;
}

const inFlightDownloads = new Set();
let refreshInFlight = false;

async function fetchJobs() {
  const res = await fetch('/api/jobs');
  if (!res.ok) return [];
  const data = await res.json();
  return data.jobs || [];
}

function fileUrl(id) {
  return `/api/jobs/${encodeURIComponent(id)}/file`;
}

async function triggerPcDownload(job) {
  const id = job?.id;
  if (!id || inFlightDownloads.has(id)) return false;

  inFlightDownloads.add(id);
  try {
    const res = await fetch(fileUrl(id));
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = job.filename || 'clip.mp4';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);
    return true;
  } catch (err) {
    console.error('Clip-Direct download failed', id, err);
    return false;
  } finally {
    inFlightDownloads.delete(id);
  }
}

/**
 * Auto-Speichern nur in einem Tab (Web Locks) und nur wenn dieser Tab sichtbar ist.
 */
async function autoDownloadReadyJobs(jobs) {
  if (!autoDownloadEnabled() || document.hidden) return;

  const pending = jobs.filter(
    (j) => j.status === 'ready' && !loadIdSet(AUTO_CLAIMED_KEY).has(j.id),
  );
  if (!pending.length) return;

  const run = async () => {
    for (const job of pending) {
      if (!tryClaimAutoDownload(job.id)) continue;
      const ok = await triggerPcDownload(job);
      if (!ok) {
        const claimed = loadIdSet(AUTO_CLAIMED_KEY);
        claimed.delete(job.id);
        saveIdSet(AUTO_CLAIMED_KEY, claimed);
      }
    }
  };

  if (navigator.locks?.request) {
    await navigator.locks.request('clip-direct-autodownload', { ifAvailable: true }, async (lock) => {
      if (lock) await run();
    });
  } else {
    await run();
  }
}

function renderJob(job) {
  const pct = Math.round((job.progress || 0) * 100);
  const isReady = job.status === 'ready';
  const isError = job.status === 'error';
  const isRunning = job.status === 'running' || job.status === 'pending';

  const div = document.createElement('article');
  div.className = 'job' + (isError ? ' error' : '') + (isReady ? ' ready' : '');
  div.dataset.id = job.id;

  let statusLabel = job.status;
  if (job.status === 'running') statusLabel = 'Läuft…';
  if (job.status === 'ready') statusLabel = 'Bereit';
  if (job.status === 'error') statusLabel = 'Fehler';

  div.innerHTML = `
    <div class="url">${escapeHtml(job.url || '')}</div>
    <div class="status">${escapeHtml(statusLabel)}</div>
    <div class="msg">${escapeHtml(job.msg || job.error || '')}</div>
    ${isRunning ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
    <div class="actions"></div>
  `;

  const actions = div.querySelector('.actions');
  if (isReady) {
    const dl = document.createElement('button');
    dl.textContent = 'Auf PC speichern';
    dl.addEventListener('click', () => {
      void triggerPcDownload(job);
    });
    actions.appendChild(dl);
  }
  if (isReady || isError) {
    const rm = document.createElement('button');
    rm.className = 'secondary';
    rm.textContent = 'Entfernen';
    rm.addEventListener('click', async () => {
      await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
      const claimed = loadIdSet(AUTO_CLAIMED_KEY);
      claimed.delete(job.id);
      saveIdSet(AUTO_CLAIMED_KEY, claimed);
      refresh();
    });
    actions.appendChild(rm);
  }

  return div;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let pollTimer = null;

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const jobs = await fetchJobs();
    const root = document.getElementById('jobs');
    const empty = document.getElementById('empty');
    const tabWarn = document.getElementById('tabWarn');
    root.innerHTML = '';
    if (!jobs.length) {
      empty.hidden = false;
      if (tabWarn) tabWarn.hidden = true;
      schedulePoll(5000);
      return;
    }
    empty.hidden = true;
    jobs.sort((a, b) => (a.id < b.id ? 1 : -1));
    for (const job of jobs) {
      root.appendChild(renderJob(job));
    }
    await autoDownloadReadyJobs(jobs);
    const hasActive = jobs.some((j) => j.status === 'running' || j.status === 'pending');
    schedulePoll(hasActive ? 2000 : 8000);
  } finally {
    refreshInFlight = false;
  }
}

function schedulePoll(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => refresh(), ms);
}

/** Warnt, wenn mehrere Tabs dieselbe Origin offen haben. */
function setupTabWarning() {
  const el = document.getElementById('tabWarn');
  if (!el || !('BroadcastChannel' in window)) return;

  const channel = new BroadcastChannel('clip-direct-ui');
  const tabId = crypto.randomUUID();
  const peers = new Set();

  channel.postMessage({ type: 'hello', tabId });

  channel.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.tabId === tabId) return;
    if (msg.type === 'hello') {
      peers.add(msg.tabId);
      channel.postMessage({ type: 'hello', tabId });
      el.hidden = false;
    }
  };

  window.addEventListener('beforeunload', () => {
    channel.postMessage({ type: 'bye', tabId });
    channel.close();
  });
}

function ensureSettingsBar() {
  if (document.getElementById('settingsBar')) return;
  const bar = document.createElement('div');
  bar.id = 'settingsBar';
  bar.style.marginBottom = '16px';
  const label = document.createElement('label');
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.gap = '8px';
  label.style.color = '#9aa0a6';
  label.style.fontSize = '0.9rem';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = autoDownloadEnabled();
  cb.addEventListener('change', () => setAutoDownload(cb.checked));
  label.appendChild(cb);
  label.appendChild(document.createTextNode('Bei „Bereit“ automatisch Speichern-Dialog (einmal pro Clip)'));
  bar.appendChild(label);
  const hint = document.createElement('p');
  hint.style.color = '#9aa0a6';
  hint.style.fontSize = '0.8rem';
  hint.style.margin = '8px 0 0';
  hint.textContent =
    'Nur ein Tab mit dieser Seite offen. Auto-Speichern läuft nur im sichtbaren Tab.';
  bar.appendChild(hint);
  document.querySelector('header').after(bar);
}

ensureSettingsBar();
setupTabWarning();
refresh();
