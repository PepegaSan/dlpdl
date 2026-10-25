/**
 * Isolated-world gate for keep-playback.js.
 * MAIN world cannot read chrome.storage; this script does, then injects
 * only when Settings → keepPlayback is on (default) AND the page shows a
 * <video>. Pages without one stay untouched.
 */
(function () {
  const DEFAULT_ON = true;
  const WAIT_FOR_VIDEO_MS = 60000;

  function hasVideo() {
    try {
      return Boolean(document.querySelector('video'));
    } catch {
      return false;
    }
  }

  function whenVideoAppears(callback) {
    if (hasVideo()) {
      callback();
      return;
    }
    const observer = new MutationObserver(() => {
      if (hasVideo()) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    // Same cap as the clip bar: a page that never shows a video is left alone.
    setTimeout(() => observer.disconnect(), WAIT_FOR_VIDEO_MS);
  }

  function inject() {
    const root = document.documentElement;
    if (!root || root.dataset.clipDirectKeepPlayback === '1') return;
    root.dataset.clipDirectKeepPlayback = '1';
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('lib/keep-playback.js');
    script.onload = () => script.remove();
    script.onerror = () => {
      delete root.dataset.clipDirectKeepPlayback;
    };
    root.appendChild(script);
  }

  try {
    chrome.storage.sync.get({ keepPlayback: DEFAULT_ON }, (data) => {
      if (chrome.runtime.lastError) return;
      if (data.keepPlayback === false) return;
      whenVideoAppears(inject);
    });
  } catch {
    /* extension context gone after reload */
  }
})();
