/**
 * Extension UI i18n (default: English). Locale files: lib/locales/{en,de}.json
 */

import { loadSettings } from './storage.js';

let dict = {};
let locale = 'en';

function interpolate(template, params = {}) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => (
    params[key] !== undefined ? String(params[key]) : `{${key}}`
  ));
}

export function getLocale() {
  return locale;
}

export async function initI18n(forcedLocale) {
  if (forcedLocale === 'de' || forcedLocale === 'en') {
    locale = forcedLocale;
  } else {
    const settings = await loadSettings();
    locale = settings.uiLocale === 'de' ? 'de' : 'en';
  }
  const url = chrome.runtime.getURL(`lib/locales/${locale}.json`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`locale fetch failed: ${locale}`);
  }
  dict = await res.json();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
  return locale;
}

export function t(key, params) {
  const template = dict[key] ?? key;
  return interpolate(template, params);
}

/** Apply data-i18n and data-i18n-attr="title" on static markup. */
export function applyI18n(root = document) {
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
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}
