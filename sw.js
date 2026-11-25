/* MiMoni Service Worker v11 */
const CACHE_NAME = 'mimoni-offline-cache-v11';
const APP_SHELL_FILES = [
  './', './index.html', './styles.css', './app.js', './manifest.json', './offline.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null)))
  );
  self.clients.claim();
});

function saveSharedFilesToIndexedDB(files) {
  return new Promise((resolve) => {
    const req = indexedDB.open('MiMoniOfflineVaultDB', 5);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shared_queue')) return resolve();
      const tx = db.transaction('shared_queue', 'readwrite');
      const store = tx.objectStore('shared_queue');
      files.forEach((file, idx) => store.put({ id: 'shared_' + Date.now() + '_' + idx, file, timestamp: Date.now() }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        const formData = await event.request.formData();
        const files = formData.getAll('receipt').filter(Boolean);
        if (files.length > 0) await saveSharedFilesToIndexedDB(files);
      } catch (e) {}
      return Response.redirect('./index.html?share_target=1', 303);
    })());
    return;
  }
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match('./offline.html')))
  );
});
