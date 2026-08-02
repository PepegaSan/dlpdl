/** @param {number} seconds */
export function formatClockTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600);
  if (hr > 0) {
    return `${hr}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/** Parse M:SS, H:MM:SS, plain seconds, or YouTube-style 90s / 2m / 1h. */
export function parseClockTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : NaN;
  }
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10);
  }
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

/** @returns {string|null} normalized clock string or null if invalid */
export function normalizeClockTime(value) {
  const sec = parseClockTime(value);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return formatClockTime(sec);
}
