const CACHE_NAME = 'estudio-fitness-v6';

// Assets estáticos: íconos, estilos, manifesto — estrategia Cache-First
const STATIC_ASSETS = [
  './',
  './index.html',
  './src/styles.css',
  './src/logo.svg',
  './icons/icon-192x192.svg',
  './icons/icon-512x512.svg',
  './icons/apple-touch-icon.svg',
  './icons/favicon.svg',
  './manifest.json'
];

// Archivos de lógica JS — estrategia Network-First
// El browser siempre intenta la red para obtener la versión actualizada.
// Si la red falla (modo offline), usa la versión cacheada como fallback.
const NETWORK_FIRST_ASSETS = [
  './src/supabase.js',
  './src/data.js',
  './src/app.js'
];

// Pre-cachear todos los assets en la instalación
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([...STATIC_ASSETS, ...NETWORK_FIRST_ASSETS])
    )
  );
  // Tomar control inmediato sin esperar a que cierren las pestañas anteriores
  self.skipWaiting();
});

// Al activar: eliminar caches de versiones anteriores
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  // Tomar control de todos los clientes abiertos inmediatamente
  self.clients.claim();
});

// Estrategia de fetch según el tipo de recurso
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const pathname = url.pathname;

  // Solo interceptar peticiones al mismo origen (no CDN externas como Supabase)
  if (url.origin !== self.location.origin) {
    return; // No interceptar peticiones externas (Supabase API, CDN)
  }

  // Network-First para los archivos de lógica JS
  const isNetworkFirst = NETWORK_FIRST_ASSETS.some((asset) =>
    pathname.endsWith(asset.replace('./', '/'))
  );

  if (isNetworkFirst) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // Actualizar el caché con la versión fresca de la red
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) =>
            cache.put(event.request, responseClone)
          );
          return networkResponse;
        })
        .catch(() => {
          // Red no disponible: servir desde caché (modo offline)
          return caches.match(event.request);
        })
    );
    return;
  }

  // Cache-First para assets estáticos (íconos, estilos, HTML)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});

// RECEPCIÓN DE NOTIFICACIONES PUSH REALES DESDE EL SERVIDOR (VAPID)
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

// CLICK EN LA NOTIFICACIÓN DEL SISTEMA OPERATIVO
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
