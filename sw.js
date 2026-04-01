// ═══════════════════════════════════════════════════════════════════
// SafeConnect — Service Worker (sw.js)
// Version: 2.8
//
// Sections:
//   1. Config & Cache Names
//   2. Install  — pre-cache critical files
//   3. Activate — clean up old caches
//   4. Fetch    — serve from cache when offline
//   5. Sync     — flush queued pings/SOS/parking when back online
//   6. Push     — show notifications for vehicle alerts / SOS
// ═══════════════════════════════════════════════════════════════════

// ── 1. Config ────────────────────────────────────────────────────────
const SW_VERSION    = 'v2.8';
const CACHE_STATIC  = `safeconnect-static-${SW_VERSION}`;
const CACHE_TILES   = `safeconnect-tiles-${SW_VERSION}`;
const API_BASE      = 'https://safeconnect-api-xxxxxx-uc.a.run.app'; // update on deploy

// Files to pre-cache at install time
// These make the app load even with zero internet
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Leaflet CSS + JS
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  // Fonts (cache what's fetched on first load)
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap',
];

// Sync tag names — must match exactly what index.html registers
const SYNC_LOCATIONS = 'sync-locations';
const SYNC_SOS       = 'sync-sos';
const SYNC_PARKING   = 'sync-parking';

// IndexedDB config — mirrors what index.html uses
const IDB_NAME      = 'safeconnect-queue';
const IDB_VERSION   = 1;
const STORE_LOCATION= 'location-queue';
const STORE_SOS     = 'sos-queue';
const STORE_PARKING = 'parking-queue';


// ── 2. Install ───────────────────────────────────────────────────────
// Fires once when sw.js is first registered or updated.
// Pre-downloads all critical files so the app works offline immediately.

self.addEventListener('install', event => {
  console.log(`[SW ${SW_VERSION}] Installing...`);

  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => {
        console.log(`[SW] Pre-caching ${PRECACHE_URLS.length} files`);
        // Use individual adds so one failure doesn't block everything
        return Promise.allSettled(
          PRECACHE_URLS.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SW] Pre-cache failed for ${url}:`, err.message)
            )
          )
        );
      })
      .then(() => {
        console.log(`[SW] Install complete`);
        // Skip waiting — activate immediately without waiting for old SW to die
        return self.skipWaiting();
      })
  );
});


// ── 3. Activate ──────────────────────────────────────────────────────
// Fires after install. Clean up old cache versions.
// Claim all open clients so new SW takes over without page reload.

self.addEventListener('activate', event => {
  console.log(`[SW ${SW_VERSION}] Activating...`);

  event.waitUntil(
    caches.keys()
      .then(keys => {
        const toDelete = keys.filter(key =>
          (key.startsWith('safeconnect-static-') || key.startsWith('safeconnect-tiles-'))
          && key !== CACHE_STATIC
          && key !== CACHE_TILES
        );
        if (toDelete.length) {
          console.log(`[SW] Deleting old caches:`, toDelete);
        }
        return Promise.all(toDelete.map(key => caches.delete(key)));
      })
      .then(() => {
        console.log(`[SW] Activated — claiming clients`);
        return self.clients.claim();
      })
  );
});


// ── 4. Fetch ─────────────────────────────────────────────────────────
// Intercepts every network request.
// Different caching strategy per request type.

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── API calls — always go to network, never cache ──
  // JWT auth means cached responses would be stale or unauthorised
  if (url.href.includes(API_BASE) || url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // ── OTP / Auth — never cache ──
  if (url.pathname.includes('/auth/')) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // ── OpenStreetMap tiles — cache first, long TTL ──
  // Tiles rarely change. Cache aggressively to save data on slow networks.
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(cacheTiles(event.request));
    return;
  }

  // ── Google Fonts — cache first ──
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request, CACHE_STATIC));
    return;
  }

  // ── CDN scripts (Leaflet, leaflet-heat) — cache first ──
  if (url.hostname.includes('unpkg.com') ||
      url.hostname.includes('cdn.jsdelivr.net')) {
    event.respondWith(cacheFirst(event.request, CACHE_STATIC));
    return;
  }

  // ── App shell (index.html, manifest, icons) — cache first ──
  // Falls back to network if not cached yet
  event.respondWith(cacheFirst(event.request, CACHE_STATIC));
});

// Strategy: network only — no caching at all
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Offline — request queued' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Strategy: cache first — serve from cache, update cache in background
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone()); // update cache in background
    }
    return response;
  } catch {
    // Offline and not cached — return offline page for navigation requests
    if (request.mode === 'navigate') {
      const cached = await caches.match('/index.html');
      if (cached) return cached;
    }
    return new Response('Offline', { status: 503 });
  }
}

// Strategy: tiles — cache first with 200-tile limit to cap storage
async function cacheTiles(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_TILES);
      // Enforce storage limit — delete oldest if over 200 tiles
      const keys = await cache.keys();
      if (keys.length > 200) {
        await cache.delete(keys[0]);
      }
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Tile unavailable offline', { status: 503 });
  }
}


// ── 5. Background Sync ───────────────────────────────────────────────
// Fires when the device comes back online.
// Flushes any GPS pings / SOS alerts / parking events queued in IndexedDB.
//
// index.html calls reg.sync.register('sync-locations') etc when it detects
// network restoration. This handler is what actually runs the flush.

self.addEventListener('sync', event => {
  console.log(`[SW] Background sync triggered: ${event.tag}`);

  if (event.tag === SYNC_LOCATIONS) {
    event.waitUntil(syncQueue(STORE_LOCATION, '/api/v1/location/batch'));
  }
  if (event.tag === SYNC_SOS) {
    event.waitUntil(syncQueue(STORE_SOS, '/api/v1/sos'));
  }
  if (event.tag === SYNC_PARKING) {
    event.waitUntil(syncQueue(STORE_PARKING, '/api/v1/parking/events'));
  }
});

// Open IndexedDB and flush all queued records to backend
async function syncQueue(storeName, endpoint) {
  let db;
  try {
    db = await openIDB();
    const items = await getAllFromStore(db, storeName);

    if (!items.length) {
      console.log(`[SW] ${storeName}: nothing to sync`);
      return;
    }

    console.log(`[SW] ${storeName}: syncing ${items.length} queued items`);

    // Get JWT from IndexedDB auth store (saved by index.html on login)
    const token = await getToken(db);

    for (const item of items) {
      try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify(item.data)
        });

        if (res.ok) {
          // Successfully sent — remove from queue
          await deleteFromStore(db, storeName, item.id);
          console.log(`[SW] ${storeName}: synced item ${item.id}`);
        } else {
          console.warn(`[SW] ${storeName}: server rejected item ${item.id} — status ${res.status}`);
          // Don't delete — will retry next sync
        }
      } catch (err) {
        console.warn(`[SW] ${storeName}: failed to sync item ${item.id}:`, err.message);
        // Network error — will retry next sync
        throw err; // Re-throw so browser retries the sync tag
      }
    }
  } catch (err) {
    console.error(`[SW] syncQueue(${storeName}) error:`, err);
    throw err;
  } finally {
    if (db) db.close();
  }
}


// ── 6. Push Notifications ────────────────────────────────────────────
// Fires when backend sends a Web Push message.
// Currently a stub — Phase 2B will wire up the backend push sender.
//
// Expected payload from backend:
// {
//   type: 'vehicle_moved' | 'sos_confirmed' | 'notice' | 'zone_alert',
//   title: string,
//   body:  string,
//   url:   string  (where to navigate on tap)
// }

self.addEventListener('push', event => {
  console.log('[SW] Push received');

  let data = { title: 'SafeConnect', body: 'New alert', url: '/' };
  try {
    data = event.data ? event.data.json() : data;
  } catch (e) {
    console.warn('[SW] Push payload parse error:', e);
  }

  const options = {
    body:    data.body,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    vibrate: [200, 100, 200],       // buzz pattern on Android
    data:    { url: data.url || '/' },
    actions: getNotificationActions(data.type),
    tag:     data.type || 'general', // replace previous notification of same type
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'SafeConnect', options)
  );
});

// Notification action buttons per type
function getNotificationActions(type) {
  if (type === 'vehicle_moved') {
    return [
      { action: 'navigate', title: '🧭 Navigate to Vehicle' },
      { action: 'dismiss',  title: '✕ Dismiss' }
    ];
  }
  if (type === 'sos_confirmed') {
    return [
      { action: 'view', title: '🆘 View Alert' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ];
  }
  return [{ action: 'open', title: '📱 Open App' }];
}

// User taps a notification or action button
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // If app is already open — focus it and navigate
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.focus();
            client.postMessage({ type: 'NAVIGATE', url });
            return;
          }
        }
        // App not open — open a new window
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      })
  );
});


// ═══════════════════════════════════════════════════════════════════
// IndexedDB Helpers
// Used by background sync to read/delete queued items.
// index.html writes to these stores; sw.js reads and flushes them.
// ═══════════════════════════════════════════════════════════════════

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      // Create stores if they don't exist
      if (!db.objectStoreNames.contains(STORE_LOCATION)) {
        db.createObjectStore(STORE_LOCATION, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_SOS)) {
        db.createObjectStore(STORE_SOS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PARKING)) {
        db.createObjectStore(STORE_PARKING, { keyPath: 'id', autoIncrement: true });
      }
      // Auth store — holds JWT token so SW can authenticate sync requests
      if (!db.objectStoreNames.contains('auth')) {
        db.createObjectStore('auth', { keyPath: 'key' });
      }
    };

    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(storeName)) {
      resolve([]); return;
    }
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror   = e => reject(e.target.error);
  });
}

function deleteFromStore(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function getToken(db) {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains('auth')) { resolve(null); return; }
    const tx  = db.transaction('auth', 'readonly');
    const req = tx.objectStore('auth').get('jwt');
    req.onsuccess = e => resolve(e.target.result?.value || null);
    req.onerror   = () => resolve(null);
  });
}

console.log(`[SW ${SW_VERSION}] Script loaded`);
