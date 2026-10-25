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

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Same host, or one is a subdomain of the other. */
export function hostsRelated(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
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
 * Cookies the browser itself would send to the stream host: its own (also
 * those set on a parent domain) plus CHIPS-partitioned ones under the page's
 * top-level site. Cookies of the embedding page or of unrelated CDNs never
 * reach the stream host in the browser either, so they are not sent along —
 * that keeps the page's session private and the Cookie header small.
 * @returns {Promise<string>} Cookie header value
 */
export async function collectStreamCookies(streamUrl, pageUrl = '', tabUrl = '') {
  const streamHost = hostOf(streamUrl);
  if (!streamHost) return '';
  const topLevels = httpOrigins(pageUrl, tabUrl);

  const jar = new Map();
  const absorb = (list) => {
    for (const c of list || []) {
      if (c.name && c.value != null) {
        jar.set(c.name, c.value);
      }
    }
  };

  absorb(await getCookiesSafe({ url: streamUrl }));
  for (const topLevelSite of topLevels) {
    absorb(await getCookiesSafe({ url: streamUrl, partitionKey: { topLevelSite } }));
  }
  // Known CDN roots only when the stream belongs to that domain family.
  for (const domain of CDN_ROOT_DOMAINS) {
    if (!hostsRelated(streamHost, domain)) continue;
    absorb(await getCookiesSafe({ domain }));
    for (const topLevelSite of topLevels) {
      absorb(await getCookiesSafe({ domain, partitionKey: { topLevelSite } }));
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
