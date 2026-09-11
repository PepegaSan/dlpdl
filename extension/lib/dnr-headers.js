/**
 * Attach Referer/Origin/User-Agent to extension fetches (fetch() forbids
 * setting Referer). Requires declarativeNetRequestWithHostAccess.
 */

const RULE_ID = 71931;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function setStreamFetchHeaders(streamUrl, headers = {}) {
  const host = hostOf(streamUrl);
  if (!host || !chrome.declarativeNetRequest?.updateSessionRules) {
    return;
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
  if (!requestHeaders.length) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          priority: 100,
          action: { type: 'modifyHeaders', requestHeaders },
          condition: {
            requestDomains: [host],
            resourceTypes: ['xmlhttprequest', 'other', 'media'],
          },
        },
      ],
    });
  } catch (err) {
    console.warn('Clip-Direct: DNR header rule failed', err);
  }
}

export async function clearStreamFetchHeaders() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [],
    });
  } catch {
    /* ignore */
  }
}
