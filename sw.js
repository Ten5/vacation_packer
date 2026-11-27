const CACHE_NAME = 'packlist-pwa-v3';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './firebase-config.js',
  './firebase-sync.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

const EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/@phosphor-icons/web',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap'
];

const CDN_ORIGINS = new Set([
  'https://cdn.tailwindcss.com',
  'https://unpkg.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://www.gstatic.com'
]);

async function cacheExternalAssets(cache) {
  await Promise.allSettled(
    EXTERNAL_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url);
        if (res && res.ok) {
          await cache.put(url, res);
          return;
        }
      } catch (e) {
        // Fall back to opaque no-cors fetch below
      }
      const opaqueReq = new Request(url, { mode: 'no-cors' });
      const opaqueRes = await fetch(opaqueReq);
      if (opaqueRes) {
        await cache.put(opaqueReq, opaqueRes);
      }
    })
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_ASSETS);
      await cacheExternalAssets(cache);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('packlist-pwa-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Navigation requests: network-first (bypassing HTTP cache) so fresh deploys appear immediately, with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const networkResponse = await fetch(request.url, { cache: 'no-cache' });
          if (networkResponse && networkResponse.ok) {
            await cache.put('./index.html', networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./'))
          );
        }
      })()
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => undefined);

        return cached || (await fetchPromise) || Response.error();
      })()
    );
    return;
  }

  // External CDN assets: cache-first with background revalidation (supports opaque responses)
  if (CDN_ORIGINS.has(url.origin)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => undefined);

        if (cached) {
          event.waitUntil(fetchPromise);
          return cached;
        }
        return (await fetchPromise) || Response.error();
      })()
    );
  }
});
