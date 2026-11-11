// DPS Stationery - Service Worker v9 (Silent Auto-Update & Real-Time Push)
const CACHE_NAME = 'dps-stationery-v9';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/Dps.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/icon.svg',
  '/login-panel.png',
  '/login-panel.jpg'
];

// Install: Pre-cache core shell & immediately take over (skipWaiting)
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.all(
        STATIC_ASSETS.map(url => {
          return cache.add(url).catch(err => {
            console.warn('[SW] Cache prefetch warning:', url, err.message);
          });
        })
      );
    })
  );
});

// Activate: Immediately claim all clients and silently delete older caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Purging obsolete cache:', k);
          return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Silent background updates with Network-First navigation & API
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Never intercept or cache live notification streams or live app data sync
  if (url.pathname.startsWith('/api/notifications') || url.pathname.startsWith('/api/data')) {
    return;
  }

  // 1. Dynamic API requests: Network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 2. HTML navigation requests: Network-first (silent update on every visit)
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => caches.match('/') || caches.match('/index.html') || caches.match('/Dps.html'))
    );
    return;
  }

  // 3. Static assets: Stale-While-Revalidate (instant load + silent background refresh)
  event.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// Native Push Notifications
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'DPS Stationery Alert', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'DPS Stationery Alert';
  const options = {
    body: data.body || 'You have an update in stationery store.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'dps-notify-' + Date.now(),
    vibrate: [200, 100, 200],
    data: data
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Click notification: Focus active window or open application
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// Message listener from web app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const payload = event.data.payload || {};
    self.registration.showNotification(payload.title || 'DPS Stationery', {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag || 'dps-notify-' + Date.now(),
      vibrate: [200, 100, 200],
      data: payload
    });
  }
});
