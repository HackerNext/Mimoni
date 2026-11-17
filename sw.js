/* MiMoni Service Worker v5 */
const CACHE_NAME = 'mimoni-offline-cache-v5';
const APP_SHELL_FILES = [
  './', './index.html', './styles.css', './app.js', './manifest.json', './offline.html'
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL_FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(k => Promise.all(k.map(x => x !== CACHE_NAME ? caches.delete(x) : null)))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  if (e.request.method === 'POST' && e.request.url.endsWith('/share-target')) {
    e.respondWith(Response.redirect('./index.html?share_target=1', 303)); return;
  }
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(n => {
    if (n && n.status === 200) { const c = n.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, c)); }
    return n;
  }).catch(() => caches.match('./offline.html'))));
});
