// CYC CRM — Service Worker v1
// Estrategia: Network-first para /api/*, Cache-first para assets estáticos

const CACHE = 'cyc-crm-v1';
const STATIC = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(STATIC);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // SSE y /api/* → siempre red (no cachear)
  if (url.includes('/api/') || url.includes('/api/eventos')) {
    return;
  }

  // index.html → Network-first (siempre intentar la red, fallback a caché)
  if (e.request.mode === 'navigate' || url.endsWith('/') || url.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(function(resp) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
          return resp;
        })
        .catch(function() {
          return caches.match('/index.html');
        })
    );
    return;
  }

  // Resto → Cache-first
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return resp;
      });
    })
  );
});
