const CACHE_NAME = 'estudio-fitness-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './src/styles.css',
  './src/supabase.js',
  './src/data.js',
  './src/app.js',
  './src/logo.svg',
  './icons/icon-192x192.svg',
  './icons/icon-512x512.svg',
  './icons/apple-touch-icon.svg',
  './icons/favicon.svg',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) return caches.delete(cache);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});

// RECEPCIÓN DE NOTIFICACIONES PUSH REALES DESDE EL SERVIDOR (VAPID)
self.addEventListener('push', (event) => {
  let payload = {
    title: '🔥 Estudio Fitness',
    body: 'Tienes una nueva actualización en tu entrenamiento.',
    icon: './icons/icon-192x192.svg',
    url: './'
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
    data: { url: payload.url || './' },
    tag: 'estudio-fitness-push'
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});

// CLICK EN LA NOTIFICACIÓN DEL SISTEMA OPERATIVO
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          client.postMessage({ type: 'NAVIGATE_ROUTE', url: targetUrl });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
