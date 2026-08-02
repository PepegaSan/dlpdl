import { applyUiI18n, getUiLocale, initUiI18n, t } from './i18n.js';

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

function tryClaimAutoDownload(jobId) {
  const claimed = loadIdSet(AUTO_CLAIMED_KEY);
  if (claimed.has(jobId)) return false;
  claimed.add(jobId);
  saveIdSet(AUTO_CLAIMED_KEY, claimed);
  return true;
}

const inFlightDownloads = new Set();
let refreshInFlight = false;

function showApiError(err) {
  const el = document.getElementById('apiError');
  if (!el) return;
  const msg = err?.message || String(err || '');
  el.textContent = t('ui.apiError', { error: msg });
  el.hidden = false;
}

function hideApiError() {
  const el = document.getElementById('apiError');
  if (el) el.hidden = true;
}

async function fetchJobs() {
  const res = await fetch('/api/jobs', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

function fileUrl(id) {
  return `/api/jobs/${encodeURIComponent(id)}/file`;
}

function basename(path) {
  if (!path) return '';
  const parts = String(path).replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function parseContentDispositionFilename(header) {
  if (!header) return '';
  const star = header.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* ignore */
    }
  }
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1].trim();
  const plain = header.match(/filename=([^;\s]+)/i);
  return plain ? plain[1].trim().replace(/^"|"$/g, '') : '';
}

/** Drop legacy `{jobId}_` prefix from older UI versions. */
function stripJobIdPrefix(name, jobId) {
  const base = basename(name) || 'clip.mp4';
  if (!jobId) return base;
  const prefix = `${jobId}_`;
  return base.startsWith(prefix) ? base.slice(prefix.length) : base;
}

function downloadFilename(job, contentDisposition = '') {
  const fromHeader = parseContentDispositionFilename(contentDisposition);
  const fromJob = basename(job?.filename);
  const raw = fromHeader || fromJob || 'clip.mp4';
  return stripJobIdPrefix(raw, job?.id);
}

function triggerPcDownload(job) {
  const id = job?.id;
  if (!id || inFlightDownloads.has(id)) return Promise.resolve(false);
  if (job.downloadable !== true) return Promise.resolve(false);

  inFlightDownloads.add(id);
  const name = downloadFilename(job);
  const url = `${fileUrl(id)}?t=${Date.now()}`;

  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => inFlightDownloads.delete(id), 1500);
    return Promise.resolve(true);
  } catch (err) {
    console.error('Clip-Direct download failed', id, err);
    inFlightDownloads.delete(id);
    return Promise.resolve(false);
  }
}

function showDownloadError(_job, err) {
  const el = document.getElementById('apiError');
  if (!el) return;
  const code = err?.message || String(err || '');
  el.textContent = t('ui.downloadFailed', { code });
  el.hidden = false;
}

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

function jobErrorText(job) {
  const parts = [job.error, job.msg]
    .filter(Boolean)
    .map((s) => String(s).trim());
  const unique = [...new Set(parts)];
  const detail = unique.join(' — ');
  if (!detail || /^error$/i.test(detail)) return t('ui.status.errorUnknown');
  return detail;
}

function statusLabelFor(job) {
  if (job.status === 'error') return jobErrorText(job);
  if (job.status === 'running' || job.status === 'pending') {
    const detail = (job.msg || '').trim();
    if (detail) return detail;
    return t('ui.status.running');
  }
  if (job.status === 'ready') return t('ui.status.ready');
  return job.status || '';
}

function renderJob(job) {
  const pct = Math.round((job.progress || 0) * 100);
  const isReady = job.status === 'ready';
  const isError = job.status === 'error';
  const isRunning = job.status === 'running' || job.status === 'pending';
  const statusText = statusLabelFor(job);
  const progressLabel = isRunning && pct > 0 ? `${pct}%` : '';
  const msgText = isError ? '' : (job.msg || '');

  const div = document.createElement('article');
  div.className = 'job' + (isError ? ' error' : '') + (isReady ? ' ready' : '');
  div.dataset.id = job.id;

  div.innerHTML = `
    <div class="url">${escapeHtml(job.url || '')}</div>
    ${job.filename ? `<div class="file">${escapeHtml(job.filename)}</div>` : ''}
    <div class="status">${escapeHtml(statusText)}${progressLabel ? ` · ${progressLabel}` : ''}</div>
    ${msgText && !isRunning ? `<div class="msg">${escapeHtml(msgText)}</div>` : ''}
    ${isRunning ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
    <div class="actions"></div>
  `;

  const actions = div.querySelector('.actions');
  const canDownload = isReady && job.downloadable === true;
  if (isReady && !canDownload) {
    const warn = document.createElement('p');
    warn.className = 'msg';
    warn.textContent = t('ui.fileMissing');
    div.insertBefore(warn, actions);
  }
  if (canDownload) {
    const dl = document.createElement('button');
    dl.textContent = t('ui.saveToPc');
    dl.addEventListener('click', () => {
      hideApiError();
      void triggerPcDownload(job).then((ok) => {
        if (!ok) showDownloadError(job, new Error('failed'));
      });
    });
    actions.appendChild(dl);
  }
  if (isReady || isError) {
    const rm = document.createElement('button');
    rm.className = 'secondary';
    rm.textContent = t('ui.remove');
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
  let pollMs = 5000;
  try {
    const jobs = await fetchJobs();
    const root = document.getElementById('jobs');
    const empty = document.getElementById('empty');
    const tabWarn = document.getElementById('tabWarn');
    if (!root || !empty) {
      throw new Error('UI markup missing');
    }
    root.innerHTML = '';
    hideApiError();
    if (!jobs.length) {
      empty.hidden = false;
      if (tabWarn) tabWarn.hidden = true;
      pollMs = 5000;
    } else {
      empty.hidden = true;
      jobs.sort((a, b) => (a.id < b.id ? 1 : -1));
      for (const job of jobs) {
        root.appendChild(renderJob(job));
      }
      await autoDownloadReadyJobs(jobs);
      const hasActive = jobs.some((j) => j.status === 'running' || j.status === 'pending');
      pollMs = hasActive ? 2000 : 8000;
    }
  } catch (err) {
    console.error('Clip-Direct UI refresh failed', err);
    showApiError(err);
    pollMs = 5000;
  } finally {
    refreshInFlight = false;
    schedulePoll(pollMs);
  }
}

function schedulePoll(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => refresh(), ms);
}

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
  const autoText = document.createElement('span');
  autoText.setAttribute('data-i18n', 'ui.autoSave');
  label.appendChild(autoText);
  bar.appendChild(label);
  const hint = document.createElement('p');
  hint.style.color = '#9aa0a6';
  hint.style.fontSize = '0.8rem';
  hint.style.margin = '8px 0 0';
  hint.setAttribute('data-i18n', 'ui.autoSaveHint');
  bar.appendChild(hint);
  document.querySelector('header').after(bar);
  applyUiI18n(bar);
}

function setupLocaleSelector() {
  const select = document.getElementById('uiLocaleSelect');
  if (!select) return;
  select.value = getUiLocale();
  select.addEventListener('change', async () => {
    await initUiI18n(select.value);
    applyUiI18n();
    refresh();
  });
}

async function boot() {
  try {
    await initUiI18n();
  } catch (err) {
    console.error('Clip-Direct UI locale failed', err);
  }
  try {
    applyUiI18n();
    setupLocaleSelector();
    ensureSettingsBar();
    setupTabWarning();
  } catch (err) {
    console.error('Clip-Direct UI setup failed', err);
  }
  refresh();
}

boot();
