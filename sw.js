// Bump CACHE_NAME en cada deploy para forzar actualización del SW
const CACHE_NAME = 'estudio-fitness-v8';

// Solo assets que casi no cambian
const STATIC_ASSETS = [
  './icons/icon-192x192.svg',
  './icons/icon-512x512.svg',
  './icons/apple-touch-icon.svg',
  './icons/favicon.svg',
  './manifest.json',
  './src/logo.svg'
];

// Lógica y UI: siempre intentar red primero (así al reabrir se ve lo nuevo)
const NETWORK_FIRST_ASSETS = [
  './',
  './index.html',
  './src/styles.css',
  './src/supabase.js',
  './src/data.js',
  './src/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([...STATIC_ASSETS, ...NETWORK_FIRST_ASSETS]).catch(() => {})
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const pathname = url.pathname;

  if (url.origin !== self.location.origin) {
    return;
  }

  // Nunca cachear el propio SW
  if (pathname.endsWith('/sw.js')) {
    event.respondWith(fetch(event.request));
    return;
  }

  const isNetworkFirst = NETWORK_FIRST_ASSETS.some((asset) => {
    const clean = asset.replace('./', '/');
    if (asset === './') return pathname === '/' || pathname.endsWith('/');
    return pathname.endsWith(clean) || pathname.endsWith(asset.replace('./', ''));
  }) || pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.html');

  if (isNetworkFirst) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Cache-First para íconos / manifest
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

// Push notifications (sin cambios de lógica)
self.addEventListener('push', (event) => {
  let payload = {
    title: '🔥 Estudio Fitness',
    body: 'Tienes una nueva actualización en tu entrenamiento.',
    icon: './icons/icon-192x192.svg',
    url: './',
    routineId: null
  };

  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch (e) {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: payload.icon || './icons/icon-192x192.svg',
    badge: './icons/icon-192x192.svg',
    data: {
      url: payload.url || './',
      routineId: payload.routineId || null
    },
    tag: 'estudio-fitness-push'
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  const routineId = event.notification.data?.routineId || null;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          client.postMessage({ type: 'NAVIGATE_ROUTE', url: targetUrl, routineId: routineId });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});


self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
