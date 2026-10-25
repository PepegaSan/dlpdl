/**
 * Isolated-world gate for keep-playback.js.
 * MAIN world cannot read chrome.storage; this script does, then injects
 * only when Settings → keepPlayback is on (default).
 */
(function () {
  const DEFAULT_ON = true;

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
      inject();
    });
  } catch {
    /* extension context gone after reload */
  }
})();
