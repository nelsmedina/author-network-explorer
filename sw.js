// sw.js — service worker for the Author Network Explorer PWA.
// Caches the static app shell so the page loads instantly and works offline.
// API requests to OpenAlex always go to the network (never cached).

const CACHE_VERSION = 'ane-pwa-v2';
const APP_SHELL = [
  './',
  './index.html',
  './fullpage.html',
  './fullpage.js',
  './styles.css',
  './mobile.css',
  './mobile-ui.js',
  './openalex-api.js',
  './field-topology.js',
  './network-worker.js',
  './pwa-shim.js',
  './vis-network.min.js',
  './manifest.webmanifest',
  './icons/icon16.png',
  './icons/icon32.png',
  './icons/icon48.png',
  './icons/icon128.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll is atomic — if any URL fails, the install fails. Use individual
      // adds so a missing optional asset doesn't take down the whole install.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((e) => console.warn('[sw] skip cache', url, e))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept API calls — always go to the network.
  if (url.hostname === 'api.openalex.org') return;

  // Same-origin: cache-first, fall back to network, populate cache on success.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }).catch(() => cached);
      })
    );
  }
});
