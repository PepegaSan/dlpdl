/**
 * Read browser cookies for stream + page hosts.
 * webRequest often omits the Cookie header — chrome.cookies is required.
 * Third-party player iframes use partitioned cookies (CHIPS); those only
 * show up when partitionKey.topLevelSite is the page origin.
 */

const CDN_ROOT_DOMAINS = [
  'turboviplay.com',
  'turbosplayer.com',
  'emturbovid.com',
  'cloudatacdn.com',
  'cloudatacdn.net',
  'dood.video',
  'doodstream.com',
  'tnmr.org',
];

async function getCookiesSafe(query) {
  try {
    return await chrome.cookies.getAll(query);
  } catch {
    return [];
  }
}

function httpOrigins(...raws) {
  const out = new Set();
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        out.add(u.origin);
      }
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

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
 * Later sources overwrite earlier ones so stream-host cookies win collisions.
 * @returns {Promise<string>} Cookie header value
 */
export async function collectStreamCookies(streamUrl, pageUrl = '', tabUrl = '') {
  const pageFirst = [pageUrl, tabUrl].filter(Boolean);
  const urls = [...new Set([...pageFirst, streamUrl].filter(Boolean))];
  const domains = new Set(CDN_ROOT_DOMAINS);
  for (const raw of urls) {
    for (const d of domainsForUrl(raw)) {
      domains.add(d);
    }
  }
  const topLevels = httpOrigins(pageUrl, tabUrl);

  const jar = new Map();
  const absorb = (list) => {
    for (const c of list || []) {
      if (c.name && c.value != null) {
        jar.set(c.name, c.value);
      }
    }
  };

  for (const url of urls) {
    absorb(await getCookiesSafe({ url }));
    for (const topLevelSite of topLevels) {
      absorb(await getCookiesSafe({ url, partitionKey: { topLevelSite } }));
    }
  }
  for (const domain of domains) {
    absorb(await getCookiesSafe({ domain }));
    for (const topLevelSite of topLevels) {
      absorb(await getCookiesSafe({ domain, partitionKey: { topLevelSite } }));
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
