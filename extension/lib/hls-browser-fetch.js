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
  // Other hosts (also protocol-relative //cdn/…) and data:/skd: URIs keep their own form.
  if (!/^https?:$/i.test(joined.protocol) || joined.host.toLowerCase() !== base.host.toLowerCase()) {
    return joined.toString();
  }
  joined.search = base.search;
  return joined.toString();
}

/** Base for relative URIs after a redirect; a dropped signed query is passed on. */
function redirectedBase(requested, served) {
  if (!served || served === requested) return requested;
  const req = new URL(requested);
  const fin = new URL(served);
  if (req.search && !fin.search) fin.search = req.search;
  return fin.toString();
}

const backoff = (attempt, baseMs) => new Promise((r) => setTimeout(r, baseMs * (attempt + 1)));

function parseAttrs(line) {
  const body = line.slice(line.indexOf(':') + 1);
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
  let match;
  while ((match = re.exec(body))) {
    out[match[1].toUpperCase()] = (match[3] ?? match[2]).trim();
  }
  return out;
}

const VIDEO_CODEC_HINTS = ['avc', 'hvc', 'hev', 'av01', 'vp09', 'vp9', 'mp4v', 'dvh'];

/** Best video variant (resolution, then bandwidth) and its separate audio rendition. */
function parseMasterVariant(text, baseUrl) {
  const audioGroups = new Map();
  const variants = [];
  let pending = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrs(line);
      if ((attrs.TYPE || '').toUpperCase() === 'AUDIO' && attrs.URI) {
        const group = audioGroups.get(attrs['GROUP-ID'] || '') || [];
        group.push({
          isDefault: (attrs.DEFAULT || '').toUpperCase() === 'YES',
          uri: resolveHlsUri(baseUrl, attrs.URI),
        });
        audioGroups.set(attrs['GROUP-ID'] || '', group);
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      pending = parseAttrs(line);
    } else if (line && !line.startsWith('#') && pending) {
      variants.push({ attrs: pending, uri: resolveHlsUri(baseUrl, line) });
      pending = null;
    }
  }
  if (!variants.length) return { video: null, audio: null };
  const hasVideo = ({ attrs }) => {
    const codecs = (attrs.CODECS || '').toLowerCase();
    return Boolean(attrs.RESOLUTION) || !codecs || VIDEO_CODEC_HINTS.some((h) => codecs.includes(h));
  };
  const rank = ({ attrs }) => {
    const res = (attrs.RESOLUTION || '').match(/(\d+)x(\d+)/);
    return [res ? Number(res[1]) * Number(res[2]) : 0, Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0)];
  };
  const pool = variants.filter(hasVideo).length ? variants.filter(hasVideo) : variants;
  const best = pool.reduce((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return rb[0] > ra[0] || (rb[0] === ra[0] && rb[1] > ra[1]) ? b : a;
  });
  const group = audioGroups.get(best.attrs.AUDIO || '');
  const audio = group ? (group.find((g) => g.isDefault) || group[0]).uri : null;
  return { video: best.uri, audio };
}

function parseIv(hex) {
  const clean = String(hex).replace(/^0x/i, '').padStart(32, '0').slice(-32);
  return Uint8Array.from(clean.match(/../g).map((b) => parseInt(b, 16)));
}

/** `length[@offset]` → { length, offset }; offset null = continue after the previous range. */
function parseByteRange(value) {
  const match = String(value || '').trim().match(/^(\d+)(?:@(\d+))?$/);
  if (!match) return null;
  return { length: Number(match[1]), offset: match[2] != null ? Number(match[2]) : null };
}

function parseMediaPlaylist(text, baseUrl) {
  const segments = [];
  let pendingDuration = null;
  let pendingRange = null;
  let timeline = 0;
  let mediaSequence = 0;
  let discontinuity = 0;
  let unsupportedKey = '';
  const rangeEnd = new Map();
  /** fMP4/CMAF HLS: #EXT-X-MAP init segment (moov) the following fragments need. */
  let init = null;
  let key = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(line);
      const method = (attrs.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') {
        key = null;
      } else if (method === 'AES-128' && attrs.URI) {
        key = { uri: resolveHlsUri(baseUrl, attrs.URI), iv: attrs.IV ? parseIv(attrs.IV) : null };
      } else {
        unsupportedKey = method;
        key = null;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(line);
      if (attrs.URI) {
        const range = parseByteRange(attrs.BYTERANGE);
        init = {
          uri: resolveHlsUri(baseUrl, attrs.URI),
          range: range ? { length: range.length, offset: range.offset || 0 } : null,
        };
      }
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity += 1;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
    } else if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/i);
      pendingDuration = match ? Number(match[1]) : 0;
    } else if (line && !line.startsWith('#')) {
      const duration = pendingDuration != null && Number.isFinite(pendingDuration)
        ? pendingDuration
        : 0;
      const uri = resolveHlsUri(baseUrl, line);
      let range = null;
      if (pendingRange) {
        const offset = pendingRange.offset ?? (rangeEnd.get(uri) || 0);
        range = { length: pendingRange.length, offset };
        rangeEnd.set(uri, offset + pendingRange.length);
      }
      segments.push({
        uri,
        range,
        duration,
        start: timeline,
        init,
        key,
        sequence: mediaSequence + segments.length,
        discontinuity,
      });
      timeline += duration;
      pendingDuration = null;
      pendingRange = null;
    }
  }
  return { segments, duration: timeline, unsupportedKey };
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS, headers = undefined, signal = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // A cancelled job must also stop requests that are already in flight.
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      signal: ctrl.signal,
      headers,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Only network errors and 429/5xx are retried. A 403/404 will not change,
 * and hammering a CDN that is already blocking us just gets us rate-limited.
 */
function retryableStatus(status) {
  return status === 429 || status >= 500;
}

/** Playlist text plus the URL it was served from: redirects move the base for relative URIs. */
async function fetchText(url) {
  let lastErr = `HTTP error for ${url}`;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch (err) {
      lastErr = err?.message || String(err);
      if (attempt >= RETRIES - 1) break;
      await backoff(attempt, 600);
      continue;
    }
    if (retryableStatus(res.status)) {
      lastErr = `HTTP ${res.status}`;
      await backoff(attempt, 800);
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    try {
      return { text: await res.text(), url: res.url || url };
    } catch (err) {
      lastErr = err?.message || String(err);
      if (attempt >= RETRIES - 1) break;
      await backoff(attempt, 600);
    }
  }
  throw new Error(lastErr);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error('cancelled');
  }
}

/** @returns {Promise<{ blob: Blob, partial: boolean }>} partial = server honoured Range (206). */
async function fetchSegmentResponse(url, signal, range) {
  const headers = range
    ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
    : undefined;
  let lastErr = `HTTP error for ${url}`;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    throwIfAborted(signal);
    let res;
    try {
      res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, headers, signal);
    } catch (err) {
      throwIfAborted(signal);
      lastErr = err?.message || String(err);
      if (attempt >= RETRIES - 1) break;
      await backoff(attempt, 600);
      continue;
    }
    if (retryableStatus(res.status)) {
      lastErr = `HTTP ${res.status}`;
      await backoff(attempt, 800);
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    try {
      return { blob: await res.blob(), partial: res.status === 206 };
    } catch (err) {
      throwIfAborted(signal);
      lastErr = err?.message || String(err);
      if (attempt >= RETRIES - 1) break;
      await backoff(attempt, 600);
    }
  }
  throw new Error(lastErr);
}

/**
 * Segment or init bytes. `files` (uri → Promise<Blob|null>) holds the first
 * Range request per file: if the CDN ignored Range and sent the whole file,
 * every other byte range of that file is sliced from it instead of refetched.
 */
async function fetchSegment(url, signal, range = null, files = null) {
  if (!range) {
    return (await fetchSegmentResponse(url, signal, null)).blob;
  }
  const slice = (blob) => blob.slice(range.offset, range.offset + range.length);
  const first = files?.get(url);
  if (first) {
    const whole = await first;
    if (whole) return slice(whole);
  } else if (files) {
    const pending = fetchSegmentResponse(url, signal, range);
    files.set(url, pending.then((r) => (r.partial ? null : r.blob), () => null));
    const res = await pending;
    return res.partial ? res.blob : slice(res.blob);
  }
  const res = await fetchSegmentResponse(url, signal, range);
  return res.partial ? res.blob : slice(res.blob);
}

async function fetchInitSegment(init, signal, files) {
  if (!init) return null;
  return fetchSegment(init.uri, signal, init.range, files);
}

async function importAesKey(uri, signal, keys) {
  if (!keys.has(uri)) {
    keys.set(uri, (async () => {
      const raw = await (await fetchSegment(uri, signal)).arrayBuffer();
      if (raw.byteLength !== 16) {
        throw new Error(`HLS key has ${raw.byteLength} bytes instead of 16 (login/token needed?)`);
      }
      return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    })());
  }
  return keys.get(uri);
}

/** Segment bytes ready for the backend: byte range applied, AES-128 decrypted. */
async function fetchMediaSegment(seg, signal, ctx) {
  const blob = await fetchSegment(seg.uri, signal, seg.range, ctx.files);
  if (!seg.key) return blob;
  const cryptoKey = await importAesKey(seg.key.uri, signal, ctx.keys);
  const iv = seg.key.iv || new Uint8Array(16);
  if (!seg.key.iv) new DataView(iv.buffer).setUint32(12, seg.sequence);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, await blob.arrayBuffer());
  return new Blob([plain]);
}

async function resolveMediaPlaylist(playlistUrl) {
  let url = playlistUrl;
  let audioUrl = null;
  for (let depth = 0; depth < 5; depth += 1) {
    const { text, url: servedFrom } = await fetchText(url);
    const base = redirectedBase(url, servedFrom);
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variant = parseMasterVariant(text, base);
      if (!variant.video) {
        throw new Error('no variant in master playlist');
      }
      url = variant.video;
      audioUrl = audioUrl || variant.audio;
      continue;
    }
    const parsed = parseMediaPlaylist(text, base);
    if (!parsed.segments.length) {
      throw new Error('empty media playlist');
    }
    if (parsed.unsupportedKey) {
      throw new Error(`stream is encrypted with ${parsed.unsupportedKey} (DRM) — only AES-128 can be clipped`);
    }
    return { ...parsed, audioUrl };
  }
  throw new Error('too many nested HLS playlists');
}

/**
 * Download picked segments as self-contained pieces: one per
 * (discontinuity, init) run, each fMP4 run prefixed with its own init.
 */
async function downloadPieces(picked, kind, signal, ctx, onSegment) {
  const blobs = await mapPool(picked, SEGMENT_CONCURRENCY, async (seg) => {
    const data = await fetchMediaSegment(seg, signal, ctx);
    onSegment();
    return data;
  });
  throwIfAborted(signal);
  const pieces = [];
  let current = null;
  for (let i = 0; i < picked.length; i += 1) {
    const seg = picked[i];
    if (!current || current.discontinuity !== seg.discontinuity || current.init !== seg.init) {
      current = { kind, discontinuity: seg.discontinuity, init: seg.init, blobs: [] };
      if (seg.init) current.blobs.push(await fetchInitSegment(seg.init, signal, ctx.files));
      pieces.push(current);
    }
    current.blobs.push(blobs[i]);
  }
  return pieces.map((p) => ({
    kind: p.kind,
    blob: new Blob(p.blobs, { type: p.init ? 'video/mp4' : 'video/mp2t' }),
  }));
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
  let failed = false;
  async function run() {
    // Once one item failed for good, the others finish their current item and stop.
    while (next < items.length && !failed) {
      const index = next;
      next += 1;
      try {
        out[index] = await worker(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
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
 * One window. Usually a single piece (plain TS or init + fMP4 fragments).
 * Discontinuities and a separate audio rendition yield several pieces, which
 * the backend remuxes one by one and joins (`pieces` in the ingest `parts`).
 * @param {string} playlistUrl
 * @param {{ start?: number, end?: number, onProgress?: HlsProgress, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ blob: Blob, timelineStart: number, pieces: IngestPiece[] | null }>}
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
  let audio = null;
  if (parsed.audioUrl) {
    const audioParsed = await resolveMediaPlaylist(parsed.audioUrl);
    const audioPicked = segmentsForWindow(audioParsed, opts.start, opts.end);
    if (audioPicked.length) audio = { picked: audioPicked, timelineStart: audioPicked[0].start };
  }
  const total = picked.length + (audio?.picked.length || 0);
  onProgress(0.06, `HLS: ${total} segments via browser…`, {
    key: 'progress.hlsSegments',
    params: { done: 0, total },
  });
  let done = 0;
  const onSegment = () => {
    done += 1;
    onProgress(0.06 + 0.9 * (done / total), `HLS: ${done}/${total} segments`, {
      key: 'progress.hlsSegments',
      params: { done, total },
    });
  };
  // Per window: each piece gets its own init so merged parts stay decodable.
  const ctx = { files: new Map(), keys: new Map() };
  const pieces = await downloadPieces(picked, 'v', signal, ctx, onSegment);
  if (audio) {
    const audioPieces = await downloadPieces(audio.picked, 'a', signal, ctx, onSegment);
    audioPieces[0].timelineStart = audio.timelineStart;
    pieces.push(...audioPieces);
  }
  // Blobs stay out of the JS heap; the final Blob is assembled without copying.
  const blob = pieces.length === 1
    ? pieces[0].blob
    : new Blob(pieces.map((p) => p.blob), { type: 'application/octet-stream' });
  return {
    blob,
    timelineStart: picked[0].start,
    pieces: pieces.length === 1
      ? null
      : pieces.map((p) => ({ kind: p.kind, size: p.blob.size, timelineStart: p.timelineStart })),
  };
}

/**
 * @typedef {{ kind: 'v' | 'a', size: number, timelineStart?: number }} IngestPiece
 * `parts` query for POST /ingest: `timeline:bytes` per window, plus
 * `:v<bytes>,a<bytes>@<timeline>,…` when a window consists of several pieces.
 */
export function encodeIngestParts(parts) {
  return parts.map((p) => {
    const head = `${p.timelineStart}:${p.size}`;
    if (!p.pieces) return head;
    const pieces = p.pieces.map((piece) => (
      `${piece.kind}${piece.size}${piece.timelineStart != null ? `@${piece.timelineStart}` : ''}`
    ));
    return `${head}:${pieces.join(',')}`;
  }).join(';');
}

/** Whether the backend needs the `parts` query (merge or multi-piece window). */
export function needsIngestParts(parts) {
  return Array.isArray(parts) && (parts.length > 1 || parts.some((p) => p.pieces));
}

/**
 * One window, or several windows concatenated (merged clips).
 * @param {string} playlistUrl
 * @param {{ start: number, end: number }[]} windows
 * @param {HlsProgress} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ blob: Blob, timelineStart: number, parts: { size: number, timelineStart: number, pieces: IngestPiece[] | null }[] }>}
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
    return {
      blob: one.blob,
      timelineStart: one.timelineStart,
      parts: [{ size: one.blob.size, timelineStart: one.timelineStart, pieces: one.pieces }],
    };
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
    parts: parts.map((p) => ({ size: p.blob.size, timelineStart: p.timelineStart, pieces: p.pieces })),
  };
}
