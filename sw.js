// ═══════════════════════════════════════════════════
// SafeConnect PWA — Service Worker v1.5
// Offline support + Background Sync + IndexedDB queue
// ═══════════════════════════════════════════════════

const CACHE_NAME = 'safeconnect-v1.5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

const API_BASE = 'https://safeconnect-api-xxxxxx-uc.a.run.app';

// ── IndexedDB helpers ────────────────────────────────
const DB_NAME = 'safeconnect-offline';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('locationQueue')) {
        db.createObjectStore('locationQueue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('sosQueue')) {
        db.createObjectStore('sosQueue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function enqueue(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).add({ ...data, timestamp: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function dequeueAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const items = [];
    store.openCursor().onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.delete();
        cursor.continue();
      } else {
        resolve(items);
      }
    };
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Install ──────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing SafeConnect v1.5...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS.filter(url => !url.startsWith('http'))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating SafeConnect v1.5...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls — network first, queue on fail
  if (url.origin === new URL(API_BASE).origin) {
    event.respondWith(
      fetch(request.clone()).catch(async () => {
        if (request.method === 'POST') {
          const body = await request.clone().json().catch(() => ({}));
          const storeName = url.pathname.includes('sos') ? 'sosQueue' : 'locationQueue';
          await enqueue(storeName, body);
          return new Response(JSON.stringify({ queued: true, offline: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Static assets — cache first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        if (request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── Background Sync ───────────────────────────────────
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'sync-locations') {
    event.waitUntil(syncQueue('locationQueue', '/api/v1/location/batch'));
  }
  if (event.tag === 'sync-sos') {
    event.waitUntil(syncQueue('sosQueue', '/api/v1/sos'));
  }
});

async function syncQueue(storeName, endpoint) {
  try {
    const items = await dequeueAll(storeName);
    if (!items.length) return;

    console.log(`[SW] Syncing ${items.length} items from ${storeName}`);

    for (const item of items) {
      try {
        await fetch(`${API_BASE}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item)
        });
      } catch (err) {
        // Re-enqueue on failure
        await enqueue(storeName, item);
      }
    }
    console.log(`[SW] Sync complete for ${storeName}`);
  } catch (err) {
    console.error('[SW] Sync failed:', err);
  }
}

// ── Push Notifications ────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'SafeConnect Alert';
  const options = {
    body: data.body || 'You have a new alert.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [
      { action: 'view', title: 'View' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'view') {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  }
});

// ── Message from app ──────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});
