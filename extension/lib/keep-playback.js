/**
 * Keep <video> playing when the tab is in the background.
 * Many tube/CDN players call pause() on visibilitychange; that also drops
 * the warm CDN session while the user looks at the Clip-Direct UI.
 * Runs in MAIN world at document_start so it wins over the page's listeners.
 */
(function () {
  try {
    Object.defineProperty(Document.prototype, 'hidden', {
      configurable: true,
      get() {
        return false;
      },
    });
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get() {
        return 'visible';
      },
    });
  } catch {
    /* page may have locked these */
  }

  const swallow = (event) => {
    event.stopImmediatePropagation();
  };
  window.addEventListener('visibilitychange', swallow, true);
  document.addEventListener('visibilitychange', swallow, true);
  window.addEventListener('pagehide', swallow, true);
  window.addEventListener('freeze', swallow, true);

  const resumeVideos = () => {
    const nodes = document.querySelectorAll('video');
    for (const video of nodes) {
      if (video.ended || video.readyState < 2) continue;
      const play = video.play();
      if (play && typeof play.catch === 'function') {
        play.catch(() => {});
      }
    }
  };
  window.addEventListener('blur', () => {
    setTimeout(resumeVideos, 50);
  }, true);
})();
