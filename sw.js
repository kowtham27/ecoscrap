// Minimal service worker — makes the app installable as a PWA.
// Network-first for the app shell (HTML/CSS/JS): always tries to fetch the
// latest code first, only falling back to the cached copy if offline. This
// app is actively updated, so a cache-first strategy would silently trap
// users on old/broken code with no way to see fixes go live.
const CACHE_NAME = 'ecoscrap-shell-v4';
const SHELL_FILES = [
  '/', '/index.html', '/css/style.css',
  '/js/api.js', '/js/i18n.js', '/js/app.js', '/js/priceUtils.js', '/js/geoUtils.js',
  '/js/price-history.js', '/js/secure-payment.js', '/js/scrap-scanner.js',
  '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — data must always be live.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
