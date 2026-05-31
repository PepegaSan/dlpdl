/**
 * Content-script i18n bootstrap (classic script, no ES modules).
 * Sets window.clipDirectI18nReady and window.clipDirectT before content.js runs.
 */
(function () {
  const DEFAULT_LOCALE = 'en';

  function interpolate(template, params = {}) {
    if (!template) return '';
    return template.replace(/\{(\w+)\}/g, (_, key) => (
      params[key] !== undefined ? String(params[key]) : `{${key}}`
    ));
  }

  let dict = {};
  let locale = DEFAULT_LOCALE;

  window.clipDirectT = (key, params) => interpolate(dict[key] ?? key, params);

  window.clipDirectI18nReady = (async () => {
    try {
      const stored = await chrome.storage.sync.get({ uiLocale: DEFAULT_LOCALE });
      locale = stored.uiLocale === 'de' ? 'de' : 'en';
      const url = chrome.runtime.getURL(`lib/locales/${locale}.json`);
      const res = await fetch(url);
      dict = res.ok ? await res.json() : {};
      try {
        document.documentElement.lang = locale;
      } catch {
        /* ignore */
      }
    } catch {
      locale = DEFAULT_LOCALE;
      dict = {};
    }
    return locale;
  })();
})();
