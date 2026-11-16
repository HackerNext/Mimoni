/* MiMoni Service Worker — Cache-First Offline Engine + Android Share Target Interceptor */

const CACHE_NAME = 'mimoni-offline-cache-v1';
const APP_SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/screenshot-mobile.png'
];

const EXTERNAL_OCR_ASSETS = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL_FILES);
      // Pre-cache OCR scripts on first install so Tesseract runs 100% offline afterward
      for (const url of EXTERNAL_OCR_ASSETS) {
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) await cache.put(url, res);
        } catch (err) {
          console.warn('Optional OCR pre-cache skipped:', url, err);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

/* Helper to store shared screenshot files into IndexedDB for app.js pickup */
function saveSharedFilesToIndexedDB(files) {
  return new Promise((resolve) => {
    const req = indexedDB.open('MiMoniOfflineVaultDB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('shared_queue')) {
        db.createObjectStore('shared_queue', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shared_queue')) {
        resolve();
        return;
      }
      const tx = db.transaction('shared_queue', 'readwrite');
      const store = tx.objectStore('shared_queue');
      files.forEach((file, idx) => {
        store.put({
          id: 'shared_' + Date.now() + '_' + idx,
          file,
          timestamp: Date.now()
        });
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept POST from Android Share Sheet (multipart/form-data receipt image)
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const files = formData.getAll('receipt').filter(Boolean);
          if (files.length > 0) {
            await saveSharedFilesToIndexedDB(files);
          }
        } catch (err) {
          console.warn('Share target parse error:', err);
        }
        return Response.redirect('./index.html?share_target=1', 303);
      })()
    );
    return;
  }

  if (event.request.method !== 'GET') return;

  // Cache-First Strategy with Network Fallback and Offline Page Fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (event.request.url.startsWith(self.location.origin) ||
              event.request.url.includes('cdn.jsdelivr.net') ||
              event.request.url.includes('tessdata'))
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./offline.html');
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        });
    })
  );
});
