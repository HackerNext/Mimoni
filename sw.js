/* MiMoni Service Worker v6 — CRASH RECOVERY (Network First) */
const CACHE_NAME = 'mimoni-offline-cache-v6';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Wipe all previous broken caches completely
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map(key => caches.delete(key))))
  );
  self.clients.claim();
});

// Network-first approach: Bypass stuck caches and pull the rescue JS from GitHub directly
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
