/**
 * Attach Referer/Origin/User-Agent to extension fetches (fetch() forbids
 * setting Referer). Requires declarativeNetRequestWithHostAccess.
 *
 * Each browser-fetch job gets its own session rule, scoped to requests that
 * do not belong to a tab (the service worker), so the page's own player
 * requests are never rewritten.
 */

const RULE_ID_BASE = 71931;
const RULE_ID_SPAN = 1000;
let nextRuleOffset = 0;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isOurRule(id) {
  return id >= RULE_ID_BASE && id < RULE_ID_BASE + RULE_ID_SPAN;
}

/** @returns {Promise<number|null>} rule id to pass to clearStreamFetchHeaders */
export async function setStreamFetchHeaders(streamUrl, headers = {}) {
  const host = hostOf(streamUrl);
  if (!host || !chrome.declarativeNetRequest?.updateSessionRules) {
    return null;
  }
  const requestHeaders = [];
  if (headers.Referer) {
    requestHeaders.push({ header: 'referer', operation: 'set', value: String(headers.Referer) });
  }
  if (headers.Origin) {
    requestHeaders.push({ header: 'origin', operation: 'set', value: String(headers.Origin) });
  }
  if (headers['User-Agent']) {
    requestHeaders.push({
      header: 'user-agent',
      operation: 'set',
      value: String(headers['User-Agent']),
    });
  }
  if (!requestHeaders.length) return null;
  const ruleId = RULE_ID_BASE + (nextRuleOffset % RULE_ID_SPAN);
  nextRuleOffset += 1;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 100,
          action: { type: 'modifyHeaders', requestHeaders },
          condition: {
            requestDomains: [host],
            tabIds: [chrome.tabs.TAB_ID_NONE],
            resourceTypes: ['xmlhttprequest', 'other', 'media'],
          },
        },
      ],
    });
    return ruleId;
  } catch (err) {
    console.warn('Clip-Direct: DNR header rule failed', err);
    return null;
  }
}

export async function clearStreamFetchHeaders(ruleId) {
  if (ruleId == null || !chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch {
    /* ignore */
  }
}

/** Drop rules left behind by a service worker that was killed mid-download. */
export async function clearAllStreamFetchHeaders() {
  if (!chrome.declarativeNetRequest?.getSessionRules) return;
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules.map((r) => r.id).filter(isOurRule);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
  } catch {
    /* ignore */
  }
}
