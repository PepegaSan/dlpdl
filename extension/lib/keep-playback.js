/**
 * Keep <video> playing when the tab is in the background.
 * Many tube/CDN players call pause() on visibilitychange; that also drops
 * the warm CDN session while the user looks at the Clip-Direct UI.
 * Injected into MAIN world by keep-playback-boot.js when the setting is on.
 *
 * Not for first-party players (YouTube, Vimeo, …): those stay paused when
 * the user pauses. A user gesture pause is never forced back to play().
 */
(function () {
  const SKIP_HOST_SUFFIXES = [
    'youtube.com',
    'youtu.be',
    'youtube-nocookie.com',
    'vimeo.com',
    'netflix.com',
    'twitch.tv',
    'localhost',
    '127.0.0.1',
  ];

  function pageHost() {
    try {
      return location.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function shouldSkipPage() {
    const host = pageHost();
    if (!host) return false;
    return SKIP_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }

  if (shouldSkipPage()) return;
  if (window.__clipDirectKeepPlaybackInstalled) return;
  window.__clipDirectKeepPlaybackInstalled = true;

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

  const userPaused = new WeakSet();
  let lastGestureAt = 0;
  const GESTURE_MS = 1000;

  function noteGesture() {
    lastGestureAt = Date.now();
  }

  function wasUserGesture() {
    return Date.now() - lastGestureAt < GESTURE_MS || Boolean(navigator.userActivation?.isActive);
  }

  window.addEventListener('pointerdown', noteGesture, true);
  window.addEventListener('keydown', noteGesture, true);
  window.addEventListener('touchstart', noteGesture, true);

  document.addEventListener('pause', (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (wasUserGesture()) {
      userPaused.add(video);
    }
  }, true);

  document.addEventListener('play', (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (wasUserGesture()) {
      userPaused.delete(video);
    }
  }, true);

  const resumeVideos = () => {
    const nodes = document.querySelectorAll('video');
    for (const video of nodes) {
      if (userPaused.has(video) || video.ended || video.readyState < 2) continue;
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
