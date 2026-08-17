// Shared OpenAlex API key handling for Author Network Explorer.
//
// The user's key is NEVER stored in this repository. It is entered once in the
// extension's own settings page and kept in chrome.storage.sync, which is
// per-user writable data outside the extension's installed files. This is what
// makes the extension publishable to the Chrome Web Store: the shipped code
// contains no credential.
//
// Loaded as a plain script by popup.html / fullpage.html / options.html and via
// importScripts() in the background service worker. Exposes a single global,
// `ANE`, to avoid colliding with the top-level consts those files already declare.
//
// network-worker.js cannot use this module (Web Workers have no chrome.storage);
// it receives the key by postMessage instead.

(function () {
  'use strict';

  const STORAGE_KEY = 'openalexApiKey';
  const OPENALEX_HOST = 'api.openalex.org';
  const SIGNUP_URL = 'https://openalex.org/settings/api';

  // chrome.storage is async, but callers need the key inside a synchronous fetch
  // wrapper, so keep a cached copy and invalidate it when storage changes.
  let cachedKey = null;
  let cacheLoaded = false;

  function readFromStorage() {
    return new Promise((resolve) => {
      chrome.storage.sync.get([STORAGE_KEY], (result) => {
        cachedKey = (result && result[STORAGE_KEY]) || '';
        cacheLoaded = true;
        resolve(cachedKey);
      });
    });
  }

  // Keep the cache honest across contexts: saving the key in the options page
  // must take effect in an already-open popup or fullpage tab.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
        cachedKey = changes[STORAGE_KEY].newValue || '';
        cacheLoaded = true;
      }
    });
  }

  /**
   * Resolve the user's API key, loading it from storage on first call.
   * @returns {Promise<string>} the key, or '' if the user has not set one
   */
  async function getKey() {
    if (cacheLoaded) return cachedKey;
    return readFromStorage();
  }

  /** Synchronous best-effort read; '' until getKey()/ready() has run once. */
  function getKeySync() {
    return cacheLoaded ? cachedKey : '';
  }

  /** @returns {Promise<boolean>} whether a key has been configured */
  async function hasKey() {
    return Boolean(await getKey());
  }

  /** Persist a key (trimmed). Rejects empty input. */
  function setKey(key) {
    const trimmed = String(key || '').trim();
    if (!trimmed) return Promise.reject(new Error('API key is empty'));
    return new Promise((resolve) => {
      chrome.storage.sync.set({ [STORAGE_KEY]: trimmed }, () => {
        cachedKey = trimmed;
        cacheLoaded = true;
        resolve(trimmed);
      });
    });
  }

  /** Forget the stored key. */
  function clearKey() {
    return new Promise((resolve) => {
      chrome.storage.sync.remove([STORAGE_KEY], () => {
        cachedKey = '';
        cacheLoaded = true;
        resolve();
      });
    });
  }

  function isOpenAlexUrl(url) {
    return typeof url === 'string' && url.includes(OPENALEX_HOST);
  }

  /**
   * Pull OpenAlex's rate-limit / budget headers off a response.
   * OpenAlex moved to a usage budget in 2026, so the USD fields are the
   * meaningful ones; the request counters are kept for backwards compatibility.
   */
  function parseRateLimit(response) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const remainingUsd = response.headers.get('x-ratelimit-remaining-usd');
    if (remaining === null && remainingUsd === null) return null;
    return {
      limit: parseInt(response.headers.get('x-ratelimit-limit')) || 0,
      remaining: parseInt(remaining) || 0,
      limitUsd: parseFloat(response.headers.get('x-ratelimit-limit-usd')) || 0,
      remainingUsd: parseFloat(remainingUsd) || 0,
      costUsd: parseFloat(response.headers.get('x-ratelimit-cost-usd')) || 0,
      reset: response.headers.get('x-ratelimit-reset') || null,
      lastUpdated: Date.now()
    };
  }

  /**
   * Attach the user's key to an outgoing OpenAlex request.
   *
   * Sent as an Authorization: Bearer header rather than an ?api_key= query
   * param so the credential never appears in a URL (and so never lands in a
   * console log, a cached URL string, or an error message). OpenAlex's CORS
   * policy explicitly allows the Authorization header, so this adds only a
   * preflight, not a failure.
   */
  function withKey(init, key) {
    const merged = Object.assign({}, init);
    const headers = new Headers((init && init.headers) || {});
    headers.set('Authorization', `Bearer ${key}`);
    merged.headers = headers;
    return merged;
  }

  /**
   * Replace the global fetch with one that authenticates OpenAlex calls and
   * reports budget headers. Every extension context calls this once at startup,
   * which keeps key injection in exactly one place instead of at ~20 call sites.
   *
   * @param {Object} [options]
   * @param {(rateLimit: Object) => void} [options.onRateLimit] - budget callback
   */
  function installFetch(options) {
    const opts = options || {};
    const originalFetch = self.fetch.bind(self);

    self.fetch = async function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;

      if (isOpenAlexUrl(url)) {
        const key = await getKey();
        if (key) {
          // Only the string-URL form is used in this codebase; a Request object
          // already carries its own headers, so leave it alone.
          if (typeof args[0] === 'string') {
            args[1] = withKey(args[1], key);
          }
        }
      }

      const response = await originalFetch(...args);

      if (isOpenAlexUrl(url) && opts.onRateLimit) {
        const rateLimit = parseRateLimit(response);
        if (rateLimit) opts.onRateLimit(rateLimit);
      }

      return response;
    };
  }

  /**
   * Check a key against OpenAlex without saving it, so the settings page can
   * tell the user "that worked" instead of failing silently later.
   * @returns {Promise<{ok: boolean, status?: number, error?: string, rateLimit?: Object}>}
   */
  async function validateKey(key) {
    const trimmed = String(key || '').trim();
    if (!trimmed) return { ok: false, error: 'Enter a key first.' };
    try {
      // Cheapest possible call: one known author, no fields returned.
      const response = await self.fetch(
        `https://${OPENALEX_HOST}/authors/A5023888391?select=id`,
        withKey({}, trimmed)
      );
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, error: 'OpenAlex rejected that key.' };
      }
      if (response.status === 429) {
        return { ok: false, status: 429, error: 'Key is valid but its daily budget is used up.' };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, error: `OpenAlex returned ${response.status}.` };
      }
      return { ok: true, status: response.status, rateLimit: parseRateLimit(response) };
    } catch (error) {
      return { ok: false, error: `Could not reach OpenAlex: ${error.message}` };
    }
  }

  self.ANE = {
    STORAGE_KEY,
    SIGNUP_URL,
    getKey,
    getKeySync,
    hasKey,
    setKey,
    clearKey,
    validateKey,
    installFetch,
    parseRateLimit
  };
})();
