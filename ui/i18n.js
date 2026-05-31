/**
 * Web UI i18n (default: English). Locale in localStorage key clipDirectUiLocale.
 */
const LOCALE_KEY = 'clipDirectUiLocale';
const DEFAULT_LOCALE = 'en';

let dict = {};
let locale = DEFAULT_LOCALE;

function interpolate(template, params = {}) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => (
    params[key] !== undefined ? String(params[key]) : `{${key}}`
  ));
}

export function getUiLocale() {
  const stored = localStorage.getItem(LOCALE_KEY);
  return stored === 'de' ? 'de' : DEFAULT_LOCALE;
}

export async function initUiI18n(forcedLocale) {
  locale = forcedLocale === 'de' ? 'de' : (forcedLocale === 'en' ? 'en' : getUiLocale());
  localStorage.setItem(LOCALE_KEY, locale);
  const res = await fetch(`/locales/${locale}.json`);
  if (!res.ok) {
    throw new Error(`locale fetch failed: ${locale}`);
  }
  dict = await res.json();
  document.documentElement.lang = locale;
  return locale;
}

export function t(key, params) {
  return interpolate(dict[key] ?? key, params);
}

export function applyUiI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    const text = t(key);
    if (attr) {
      el.setAttribute(attr, text);
    } else {
      el.textContent = text;
    }
  });
}
