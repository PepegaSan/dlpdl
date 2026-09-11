/**
 * Per-tab stream list and clip bundle in memory + chrome.storage.session.
 */

import { normalizeClockTime, parseClockTime } from './format-time.js';

const STREAMS_KEY = 'cdDetectedStreams';
const CLIPS_KEY = 'cdTabClips';
const MAX_STREAMS = 30;
const DEBOUNCE_MS = 250;

export class TabSessionStore {
  /** @type {Record<number, object[]>} */
  streamsByTab = {};
  /** @type {Record<number, string>} */
  lastHlsSegmentUrlByTab = {};
  /** @type {Record<number, { clips: object[], pageUrl: string, pageKey: string, ts: number }>} */
  clipsByTab = {};
  /** @type {Record<number, Record<string, string>>} */
  cookieJarByTab = {};
  #streamTimer = null;
  #clipTimer = null;

  constructor() {
    chrome.storage.session.get([STREAMS_KEY, CLIPS_KEY]).then((data) => {
      const streams = data[STREAMS_KEY] || {};
      const clips = data[CLIPS_KEY] || {};
      for (const [id, list] of Object.entries(streams)) {
        this.streamsByTab[Number(id)] = list;
      }
      for (const [id, entry] of Object.entries(clips)) {
        this.clipsByTab[Number(id)] = entry;
      }
    }).catch(() => {});
  }

  #scheduleStreams() {
    if (this.#streamTimer) return;
    this.#streamTimer = setTimeout(() => {
      this.#streamTimer = null;
      chrome.storage.session.set({ [STREAMS_KEY]: this.streamsByTab }).catch(() => {});
    }, DEBOUNCE_MS);
  }

  #scheduleClips() {
    if (this.#clipTimer) return;
    this.#clipTimer = setTimeout(() => {
      this.#clipTimer = null;
      chrome.storage.session.set({ [CLIPS_KEY]: this.clipsByTab }).catch(() => {});
    }, DEBOUNCE_MS);
  }

  streams(tabId) {
    return tabId != null && this.streamsByTab[tabId] ? this.streamsByTab[tabId] : [];
  }

  addStream(tabId, entry) {
    if (tabId == null || tabId < 0) return;
    const list = this.streamsByTab[tabId] ? [...this.streamsByTab[tabId]] : [];
    const idx = list.findIndex((e) => e.url === entry.url);
    if (idx >= 0) {
      const prev = list[idx];
      list[idx] = {
        ...prev,
        ...entry,
        referer: entry.referer || prev.referer,
        origin: entry.origin || prev.origin,
        userAgent: entry.userAgent || prev.userAgent,
        cookie: entry.cookie || prev.cookie,
        ts: Math.max(entry.ts || 0, prev.ts || 0),
      };
    } else {
      list.unshift(entry);
    }
    this.streamsByTab[tabId] = list.slice(0, MAX_STREAMS);
    this.#scheduleStreams();
  }

  clearStreams(tabId) {
    if (tabId == null || tabId < 0) return;
    this.streamsByTab[tabId] = [];
    this.#scheduleStreams();
  }

  rememberHlsSegment(tabId, url) {
    if (tabId == null || tabId < 0 || !url) return;
    this.lastHlsSegmentUrlByTab[tabId] = url;
  }

  lastHlsSegmentUrl(tabId) {
    return tabId != null ? this.lastHlsSegmentUrlByTab[tabId] : null;
  }

  rememberRequestCookies(tabId, cookieHeader) {
    if (tabId == null || tabId < 0 || !cookieHeader) return;
    const jar = { ...(this.cookieJarByTab[tabId] || {}) };
    for (const part of cookieHeader.split(';')) {
      const piece = part.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      jar[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
    }
    this.cookieJarByTab[tabId] = jar;
  }

  cookieHeader(tabId) {
    const jar = this.cookieJarByTab[tabId];
    if (!jar) return '';
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clearTab(tabId) {
    if (tabId == null || tabId < 0) return;
    delete this.streamsByTab[tabId];
    delete this.lastHlsSegmentUrlByTab[tabId];
    delete this.clipsByTab[tabId];
    delete this.cookieJarByTab[tabId];
    this.#scheduleStreams();
    this.#scheduleClips();
  }

  clipEntry(tabId) {
    return tabId != null ? this.clipsByTab[tabId] : null;
  }

  setClips(tabId, clips, pageUrl, pageKey) {
    if (tabId == null || tabId < 0) return;
    if (clips?.length) {
      this.clipsByTab[tabId] = {
        clips,
        pageUrl: pageUrl || '',
        pageKey: pageKey || '',
        ts: Date.now(),
      };
    } else {
      delete this.clipsByTab[tabId];
    }
    this.#scheduleClips();
  }

  removeClipAt(tabId, index) {
    const entry = this.clipEntry(tabId);
    if (!entry?.clips) {
      return { ok: false, error: 'no_clips', clips: [] };
    }
    const clips = entry.clips.slice();
    if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
      return { ok: false, error: 'bad_index', clips };
    }
    clips.splice(index, 1);
    if (clips.length) {
      entry.clips = clips;
      entry.ts = Date.now();
    } else {
      delete this.clipsByTab[tabId];
    }
    this.#scheduleClips();
    return { ok: true, clips, pageKey: entry.pageKey || '' };
  }

  setClipMergeIncluded(tabId, index, includeInMerge) {
    const entry = this.clipEntry(tabId);
    if (!entry?.clips) {
      return { ok: false, error: 'no_clips', clips: [] };
    }
    if (!Number.isInteger(index) || index < 0 || index >= entry.clips.length) {
      return { ok: false, error: 'bad_index', clips: entry.clips };
    }
    const clips = entry.clips.map((c, i) => (
      i === index ? { ...c, includeInMerge: !!includeInMerge } : c
    ));
    entry.clips = clips;
    entry.ts = Date.now();
    this.#scheduleClips();
    return { ok: true, clips, pageKey: entry.pageKey || '' };
  }

  setClipTimesAt(tabId, index, startRaw, endRaw) {
    const entry = this.clipEntry(tabId);
    if (!entry?.clips) {
      return { ok: false, error: 'no_clips', clips: [] };
    }
    if (!Number.isInteger(index) || index < 0 || index >= entry.clips.length) {
      return { ok: false, error: 'bad_index', clips: entry.clips };
    }
    const start = normalizeClockTime(startRaw);
    const end = normalizeClockTime(endRaw);
    if (!start || !end) {
      return { ok: false, error: 'invalid_time', clips: entry.clips };
    }
    if (parseClockTime(end) <= parseClockTime(start)) {
      return { ok: false, error: 'end_before_start', clips: entry.clips };
    }
    const clips = entry.clips.map((c, i) => (
      i === index ? { ...c, start, end } : c
    ));
    entry.clips = clips;
    entry.ts = Date.now();
    this.#scheduleClips();
    return { ok: true, clips, pageKey: entry.pageKey || '' };
  }
}
