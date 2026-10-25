/**
 * Download HLS in the browser (Chrome TLS, cookies, IP) so CDNs that 403
 * Python/Docker still work. Relative child URIs inherit the parent query.
 */

const FETCH_TIMEOUT_MS = 25000;
const SEGMENT_CONCURRENCY = 3;
const RETRIES = 4;

function resolveHlsUri(baseUrl, ref) {
  const trimmed = String(ref || '').trim();
  if (!trimmed) return baseUrl;
  const joined = new URL(trimmed, baseUrl);
  const base = new URL(baseUrl);
  const refHasQuery = trimmed.includes('?');
  if (!base.search || refHasQuery || joined.search) {
    return joined.toString();
  }
  if (/^https?:/i.test(trimmed) && joined.host.toLowerCase() !== base.host.toLowerCase()) {
    return joined.toString();
  }
  joined.search = base.search;
  return joined.toString();
}

function parseMasterVariant(text, baseUrl) {
  let bestUri = null;
  let bestBw = -1;
  let pendingBw = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const match = line.match(/BANDWIDTH=(\d+)/i);
      pendingBw = match ? Number(match[1]) : 0;
    } else if (line && !line.startsWith('#')) {
      if (pendingBw != null && pendingBw > bestBw) {
        bestBw = pendingBw;
        bestUri = resolveHlsUri(baseUrl, line);
      }
      pendingBw = null;
    }
  }
  return bestUri;
}

function parseMediaPlaylist(text, baseUrl) {
  const segments = [];
  let pendingDuration = null;
  let timeline = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/i);
      pendingDuration = match ? Number(match[1]) : 0;
    } else if (line && !line.startsWith('#')) {
      const duration = pendingDuration != null && Number.isFinite(pendingDuration)
        ? pendingDuration
        : 0;
      segments.push({
        uri: resolveHlsUri(baseUrl, line),
        duration,
        start: timeline,
      });
      timeline += duration;
      pendingDuration = null;
    }
  }
  return { segments, duration: timeline };
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  let lastErr = `HTTP error for ${url}`;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      return await res.text();
    } catch (err) {
      lastErr = err?.message || String(err);
      if (attempt >= RETRIES - 1) break;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw new Error(lastErr);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error('cancelled');
  }
}

async function fetchSegment(url, signal) {
  let lastErr = `HTTP error for ${url}`;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    throwIfAborted(signal);
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      return await res.blob();
    } catch (err) {
      lastErr = err?.message || String(err);
      if (attempt >= RETRIES - 1) break;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw new Error(lastErr);
}

async function resolveMediaPlaylist(playlistUrl) {
  let url = playlistUrl;
  for (let depth = 0; depth < 5; depth += 1) {
    const text = await fetchText(url);
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variant = parseMasterVariant(text, url);
      if (!variant) {
        throw new Error('no variant in master playlist');
      }
      url = variant;
      continue;
    }
    const parsed = parseMediaPlaylist(text, url);
    if (!parsed.segments.length) {
      throw new Error('empty media playlist');
    }
    return parsed;
  }
  throw new Error('too many nested HLS playlists');
}

function segmentsForWindow(parsed, startSec, endSec) {
  const start = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const end = Number.isFinite(endSec) && endSec !== Infinity
    ? endSec
    : parsed.duration;
  if (end <= start) return [];
  return parsed.segments.filter((seg) => (
    seg.start + seg.duration > start + 0.02 && seg.start < end - 0.02
  ));
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await worker(items[index], index);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => run()));
  return out;
}

/**
 * Progress messages carry a stable `{ key, params }` so the caller can
 * translate them; `msg` is the English fallback.
 * @typedef {(frac: number, msg: string, info?: { key: string, params?: object }) => void} HlsProgress
 */

/**
 * @param {string} playlistUrl
 * @param {{ start?: number, end?: number, onProgress?: HlsProgress, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ blob: Blob, timelineStart: number }>}
 */
export async function downloadHlsInBrowser(playlistUrl, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const { signal } = opts;
  onProgress(0.02, 'HLS: loading playlist in browser…', { key: 'progress.hlsPlaylist' });
  const parsed = await resolveMediaPlaylist(playlistUrl);
  throwIfAborted(signal);
  const picked = segmentsForWindow(parsed, opts.start, opts.end);
  if (!picked.length) {
    throw new Error('no segments in time window');
  }
  const total = picked.length;
  onProgress(0.06, `HLS: ${total} segments via browser…`, {
    key: 'progress.hlsSegments',
    params: { done: 0, total },
  });
  let done = 0;
  // Blobs stay out of the JS heap; the final Blob is assembled without copying.
  const chunks = await mapPool(picked, SEGMENT_CONCURRENCY, async (seg) => {
    const data = await fetchSegment(seg.uri, signal);
    done += 1;
    onProgress(0.06 + 0.9 * (done / total), `HLS: ${done}/${total} segments`, {
      key: 'progress.hlsSegments',
      params: { done, total },
    });
    return data;
  });
  throwIfAborted(signal);
  return {
    blob: new Blob(chunks, { type: 'video/mp2t' }),
    timelineStart: picked[0].start,
  };
}

/**
 * One window, or several windows concatenated (merged clips).
 * @param {string} playlistUrl
 * @param {{ start: number, end: number }[]} windows
 * @param {HlsProgress} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ blob: Blob, timelineStart: number, parts: { size: number, timelineStart: number }[] }>}
 */
export async function downloadHlsWindows(playlistUrl, windows, onProgress, signal) {
  const ranges = (windows || []).filter((w) => w && Number.isFinite(w.start));
  if (ranges.length <= 1) {
    const one = await downloadHlsInBrowser(playlistUrl, {
      start: ranges[0]?.start,
      end: ranges[0]?.end,
      onProgress,
      signal,
    });
    return { ...one, parts: [{ size: one.blob.size, timelineStart: one.timelineStart }] };
  }
  const parts = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const part = await downloadHlsInBrowser(playlistUrl, {
      start: ranges[i].start,
      end: ranges[i].end,
      signal,
      onProgress: (frac, msg, info) => {
        const overall = (i + Math.max(0, Math.min(1, frac))) / ranges.length;
        if (onProgress) onProgress(overall, msg, info);
      },
    });
    parts.push(part);
  }
  return {
    blob: new Blob(parts.map((p) => p.blob), { type: 'video/mp2t' }),
    timelineStart: parts[0].timelineStart,
    parts: parts.map((p) => ({ size: p.blob.size, timelineStart: p.timelineStart })),
  };
}
