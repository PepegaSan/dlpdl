/**
 * Read browser cookies for CDN embed hosts (turboviplay, turbosplayer, emturbovid).
 * webRequest often omits the Cookie header — chrome.cookies is required.
 */

const CDN_ROOT_DOMAINS = [
  'turboviplay.com',
  'turbosplayer.com',
  'emturbovid.com',
  'cloudatacdn.com',
  'cloudatacdn.net',
  'dood.video',
  'doodstream.com',
];

function domainsForUrl(raw) {
  const out = new Set();
  if (!raw) return out;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    out.add(host);
    const parts = host.split('.');
    if (parts.length >= 2) {
      out.add(parts.slice(-2).join('.'));
    }
    if (parts.length >= 3) {
      out.add(parts.slice(-3).join('.'));
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Merge multiple `a=b; c=d` cookie header strings without duplicates. */
export function mergeCookieHeader(...parts) {
  const jar = new Map();
  for (const header of parts) {
    if (!header) continue;
    for (const piece of String(header).split(';')) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Collect cookies for stream + page URLs and known CDN roots.
 * @returns {Promise<string>} Cookie header value
 */
export async function collectStreamCookies(streamUrl, pageUrl = '', tabUrl = '') {
  const domains = new Set(CDN_ROOT_DOMAINS);
  for (const raw of [streamUrl, pageUrl, tabUrl]) {
    for (const d of domainsForUrl(raw)) {
      domains.add(d);
    }
  }

  const jar = new Map();
  for (const domain of domains) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ domain });
    } catch {
      continue;
    }
    for (const c of list) {
      if (c.name && c.value != null) {
        jar.set(c.name, c.value);
      }
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
