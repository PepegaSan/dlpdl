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

async function loadLocaleDict(targetLocale) {
  const res = await fetch(`/locales/${targetLocale}.json`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`locale fetch failed: ${targetLocale}`);
  }
  return res.json();
}

export async function initUiI18n(forcedLocale) {
  locale = forcedLocale === 'de' ? 'de' : (forcedLocale === 'en' ? 'en' : getUiLocale());
  localStorage.setItem(LOCALE_KEY, locale);
  try {
    dict = await loadLocaleDict(locale);
  } catch (err) {
    console.warn('Clip-Direct UI locale load failed, falling back to English', err);
    locale = 'en';
    localStorage.setItem(LOCALE_KEY, locale);
    dict = await loadLocaleDict('en');
  }
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
