/* Offline shell. Bump CACHE when you change any file below. */
const CACHE = 'dffp-v9';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/astro.js',
  './js/data.js',
  './js/core.js',
  './js/map.js',
  './js/app.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache tiles, forecasts or the radar index — always go to the network.
  if (url.origin !== location.origin) return;

  // The BOM files the Action writes: network first, fall back to the last copy.
  if (url.pathname.includes('/data/')) {
    // Cache under the bare path so the cache-busting query does not pile up
    // a new entry every hour.
    const key = new Request(url.origin + url.pathname);
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(key, copy));
        return r;
      }).catch(() => caches.match(key))
    );
    return;
  }

  // App shell: cache first, refresh in the background.
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        if (r && r.status === 200) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
