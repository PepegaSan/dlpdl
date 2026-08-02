/**
 * Stream URL heuristics for content scripts (classic script, no modules).
 * Keep in sync with extension/lib/media-sniffer.js progressive helpers.
 */
(function () {
  const PROGRESSIVE_CDN_HOST_SUFFIXES = [
    'cloudatacdn.com',
    'cloudatacdn.net',
  ];

  const EMBED_SHELL_HOST_SUFFIXES = [
    'dood.video',
    'doodstream.com',
    'dood.watch',
    'emturbovid.com',
    'turboviplay.com',
  ];

  function isEmbedShellUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
      return EMBED_SHELL_HOST_SUFFIXES.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      );
    } catch {
      return false;
    }
  }

  function isProgressiveCdnUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return PROGRESSIVE_CDN_HOST_SUFFIXES.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      );
    } catch {
      return false;
    }
  }

  function isSignedMediaUrl(url) {
    if (!url || isEmbedShellUrl(url)) return false;
    try {
      const q = new URL(url).searchParams;
      return q.has('token') && (q.has('expiry') || q.has('expires'));
    } catch {
      return false;
    }
  }

  function mediaUrlLooksLikeStream(url) {
    if (!url || typeof url !== 'string') return false;
    if (isEmbedShellUrl(url)) return false;
    const u = url.toLowerCase();
    if (u.startsWith('blob:') || u.startsWith('data:')) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    if (/\.(ts|m4s)(\?|$)/.test(u) && !u.includes('.m3u8')) return false;
    if (/\.m3u8|m3u8%2f|format=m3u8|type=m3u8/.test(u)) return true;
    if (/\.(mp4|webm|mkv|mov)(\?|$|&)/.test(u)) return true;
    if (isProgressiveCdnUrl(url)) return true;
    if (isSignedMediaUrl(url)) return true;
    return false;
  }

  window.ClipDirectStreamUrl = {
    isEmbedShellUrl,
    isProgressiveCdnUrl,
    isSignedMediaUrl,
    mediaUrlLooksLikeStream,
  };
})();
