/**
 * chrome.storage.local helpers for content scripts (callback API).
 */

export function createLocalStore(isContextValid, onInvalid) {
  function get(keys) {
    if (!isContextValid()) {
      return Promise.resolve({});
    }
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (data) => {
          if (!isContextValid()) {
            resolve({});
            return;
          }
          resolve(chrome.runtime.lastError ? {} : data || {});
        });
      } catch {
        onInvalid();
        resolve({});
      }
    });
  }

  function set(items) {
    if (!isContextValid()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve();
        return;
      }
      try {
        chrome.storage.local.set(items, () => resolve());
      } catch {
        onInvalid();
        resolve();
      }
    });
  }

  function remove(keys) {
    if (!isContextValid()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve();
        return;
      }
      try {
        chrome.storage.local.remove(keys, () => resolve());
      } catch {
        onInvalid();
        resolve();
      }
    });
  }

  return { get, set, remove };
}
