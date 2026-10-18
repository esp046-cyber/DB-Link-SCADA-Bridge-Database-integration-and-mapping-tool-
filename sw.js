/* DB-Link SCADA Bridge - Service Worker */
const SHELL_CACHE = 'dblink-scada-shell-v1';
const DYNAMIC_CACHE = 'dblink-scada-dynamic-v1';
const OFFLINE_URL = 'offline.html';

const SHELL_ASSETS = [
  './',
  'index.html',
  'offline.html',
  'manifest.webmanifest',
  'favicon.svg',
  'css/styles.css',
  'js/app.js',
  'js/scada-engine.js',
  'js/icon-generator.js'
];

// Icons are optional until generated from Module 5, so they must not break install.
const OPTIONAL_ASSETS = [
  'icons/icon-72.png', 'icons/icon-96.png', 'icons/icon-128.png', 'icons/icon-144.png',
  'icons/icon-152.png', 'icons/icon-192.png', 'icons/icon-384.png', 'icons/icon-512.png',
  'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-16x16.png', 'icons/favicon-32x32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS);
    await Promise.allSettled(OPTIONAL_ASSETS.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DYNAMIC_CACHE];
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('dblink-scada-') && !keep.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, then cached shell, then offline page.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cached = (await caches.match(req, { ignoreSearch: true })) || (await caches.match('index.html'));
        return cached || (await caches.match(OFFLINE_URL));
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate (cache-first with background refresh).
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async (res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const cache = await caches.open(DYNAMIC_CACHE);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);
    if (cached) { network.catch(() => {}); return cached; }
    const res = await network;
    return res || new Response('', { status: 504, statusText: 'Offline' });
  })());
});
