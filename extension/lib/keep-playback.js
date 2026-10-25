/**
 * Keep <video> playing when the tab is in the background.
 * Many tube/CDN players call pause() on visibilitychange; that also drops
 * the warm CDN session while the user looks at the Clip-Direct UI.
 * Injected into MAIN world by keep-playback-boot.js when the setting is on
 * and the page has a <video>.
 *
 * Not for first-party players (YouTube, Vimeo, …): those stay paused when
 * the user pauses. A user gesture pause is never forced back to play().
 * Only visibility is faked; pagehide/freeze stay untouched so the page can
 * still save state when it is really being left.
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

  const userPaused = new WeakSet();
  let lastGestureAt = 0;
  let lastBlurAt = 0;
  const GESTURE_MS = 1000;
  // A pause this soon after the window lost focus is the player reacting to
  // the focus loss, not the user.
  const BLUR_PAUSE_MS = 2000;

  function noteGesture() {
    lastGestureAt = Date.now();
  }

  function wasUserGesture() {
    return Date.now() - lastGestureAt < GESTURE_MS || Boolean(navigator.userActivation?.isActive);
  }

  window.addEventListener('pointerdown', noteGesture, true);
  window.addEventListener('keydown', noteGesture, true);
  window.addEventListener('touchstart', noteGesture, true);

  function resume(video) {
    if (userPaused.has(video) || video.ended || video.readyState < 2 || !video.paused) return;
    const play = video.play();
    if (play && typeof play.catch === 'function') {
      play.catch(() => {});
    }
  }

  document.addEventListener('pause', (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (wasUserGesture()) {
      userPaused.add(video);
      return;
    }
    // Only the video the player just paused is resumed — never every
    // <video> on the page (ads, previews, players paused out of view).
    if (Date.now() - lastBlurAt < BLUR_PAUSE_MS) {
      setTimeout(() => resume(video), 50);
    }
  }, true);

  document.addEventListener('play', (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (wasUserGesture()) {
      userPaused.delete(video);
    }
  }, true);

  window.addEventListener('blur', () => {
    lastBlurAt = Date.now();
  }, true);
})();
