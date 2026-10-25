/**
 * Optional second Clip-Direct instance on the PC ("fast server"): same NAS
 * folder, but download and re-encode run on the PC's CPU and IP. Jobs go
 * there when it answers within the probe timeout, otherwise to the main
 * server (NAS) as before.
 */

import { TOKEN_HEADER, jobsEndpoint } from './jobs-client.js';
import { normalizeClipDirectBase } from './open-ui.js';

const PROBE_TIMEOUT_MS = 1500;
const PROBE_CACHE_MS = 10_000;

let cache = { url: '', ok: false, at: 0 };

/** @returns {Promise<boolean>} the server answered `GET api/jobs` with 2xx */
export async function serverReachable(baseUrl, token = '', opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || PROBE_TIMEOUT_MS);
  try {
    const headers = token ? { [TOKEN_HEADER]: token } : {};
    const res = await fetchImpl(jobsEndpoint(baseUrl, 'api/jobs'), {
      headers,
      cache: 'no-store',
      signal: ctrl.signal,
    });
    // 401/403 means it is up but would reject every job: not usable either.
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settings with `clipDirectBaseUrl` pointing at the fast server when it is
 * enabled and answers; `serverRole` says which one was chosen. The probe
 * result is cached briefly so several clips sent at once probe only once.
 * @param {import('./storage.js').ExtensionSettings} settings
 */
export async function pickServer(settings, opts = {}) {
  const main = normalizeClipDirectBase(settings.clipDirectBaseUrl);
  const fast = String(settings.fastServerUrl || '').trim()
    ? normalizeClipDirectBase(settings.fastServerUrl)
    : '';
  if (!settings.fastServerEnabled || !fast || fast === main) {
    return { ...settings, clipDirectBaseUrl: main, serverRole: 'main' };
  }
  const now = Date.now();
  if (cache.url !== fast || now - cache.at > PROBE_CACHE_MS) {
    cache = { url: fast, ok: await serverReachable(fast, settings.apiToken, opts), at: Date.now() };
  }
  if (cache.ok) {
    return { ...settings, clipDirectBaseUrl: fast, serverRole: 'fast' };
  }
  return { ...settings, clipDirectBaseUrl: main, serverRole: 'main' };
}

/** Forget the last probe result, e.g. after the user changed the address. */
export function resetServerProbe() {
  cache = { url: '', ok: false, at: 0 };
}
