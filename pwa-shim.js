// pwa-shim.js
// Provides a minimal chrome.* API surface so the existing fullpage.js / popup.js
// code can run unchanged when loaded as a PWA in a regular browser.
// No-op when real extension APIs are present.
(function () {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return;
  }

  const OPENALEX_BASE = 'https://api.openalex.org';
  const OPENALEX_API_KEY = 'ygR9tBoWZtDgvAKDkdzcT4';
  const STORAGE_PREFIX = 'ane:';

  function readKey(k) {
    const raw = localStorage.getItem(STORAGE_PREFIX + k);
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function writeKey(k, v) {
    localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v));
  }

  const storageLocal = {
    get(keys, callback) {
      const result = {};
      let keyList = null;
      let defaults = null;
      if (Array.isArray(keys)) {
        keyList = keys;
      } else if (typeof keys === 'string') {
        keyList = [keys];
      } else if (keys && typeof keys === 'object') {
        keyList = Object.keys(keys);
        defaults = keys;
      }
      if (keyList === null) {
        for (let i = 0; i < localStorage.length; i++) {
          const sk = localStorage.key(i);
          if (sk && sk.startsWith(STORAGE_PREFIX)) {
            const k = sk.slice(STORAGE_PREFIX.length);
            const v = readKey(k);
            if (v !== undefined) result[k] = v;
          }
        }
      } else {
        for (const k of keyList) {
          const v = readKey(k);
          if (v !== undefined) result[k] = v;
          else if (defaults) result[k] = defaults[k];
        }
      }
      if (callback) { callback(result); return; }
      return Promise.resolve(result);
    },

    set(items, callback) {
      try {
        for (const k of Object.keys(items)) writeKey(k, items[k]);
      } catch (e) {
        console.warn('[pwa-shim] storage.set failed:', e);
      }
      if (callback) { callback(); return; }
      return Promise.resolve();
    },

    remove(keys, callback) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) localStorage.removeItem(STORAGE_PREFIX + k);
      if (callback) { callback(); return; }
      return Promise.resolve();
    },

    clear(callback) {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const sk = localStorage.key(i);
        if (sk && sk.startsWith(STORAGE_PREFIX)) toRemove.push(sk);
      }
      for (const sk of toRemove) localStorage.removeItem(sk);
      if (callback) { callback(); return; }
      return Promise.resolve();
    },
  };

  async function fetchOpenAlex(endpoint) {
    const url = endpoint.startsWith('http') ? endpoint : `${OPENALEX_BASE}${endpoint}`;
    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${separator}api_key=${OPENALEX_API_KEY}`;
    try {
      const response = await fetch(fullUrl, {
        headers: { 'User-Agent': 'AuthorNetworkExplorer/1.0 (PWA)' },
      });
      if (!response.ok) {
        return { success: false, error: `OpenAlex API error: ${response.status}` };
      }
      const data = await response.json();
      return { success: true, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  const runtime = {
    getURL(path) {
      return new URL(path, document.baseURI).href;
    },
    sendMessage(message) {
      if (message && message.type === 'fetchOpenAlex') {
        return fetchOpenAlex(message.endpoint);
      }
      // Background-only messages (clearBadge, openTab, paper-check triggers)
      // are no-ops in the PWA — there's no background worker to listen.
      return Promise.resolve(undefined);
    },
    onMessage: { addListener() {}, removeListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    lastError: null,
  };

  const tabs = {
    create({ url } = {}) {
      if (url) window.location.href = url;
      return Promise.resolve();
    },
  };

  const action = {
    setBadgeText() {},
    setBadgeBackgroundColor() {},
    onClicked: { addListener() {} },
  };

  const alarms = {
    create() {},
    clear() {},
    onAlarm: { addListener() {} },
  };

  const notifications = {
    create() {},
    clear() {},
  };

  window.chrome = window.chrome || {};
  window.chrome.storage = { local: storageLocal };
  window.chrome.runtime = runtime;
  window.chrome.tabs = tabs;
  window.chrome.action = action;
  window.chrome.alarms = alarms;
  window.chrome.notifications = notifications;
})();
