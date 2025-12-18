const CACHE_NAME = 'krakow-webcam-v6';

const CRITICAL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './streams.json',
];

const OPTIONAL_ASSETS = [
  './favicon.ico',
  './android-chrome-192x192.png',
  './android-chrome-512x512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.12/dist/hls.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache critical assets - fail installation if these fail
      await cache.addAll(CRITICAL_ASSETS.map(url => new Request(url, { cache: 'reload' })));
      
      // Cache optional assets - don't fail installation if these fail
      await Promise.allSettled(
        OPTIONAL_ASSETS.map(url => 
          cache.add(new Request(url, { cache: 'reload' }))
            .catch(err => console.warn(`Failed to cache optional asset ${url}:`, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Skip video streams and weather API from caching
  if (
    event.request.url.includes('.m3u8') || 
    event.request.url.includes('.ts') ||
    event.request.url.includes('api.open-meteo.com')
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }
      return fetch(event.request).then((response) => {
        // Cache new assets if they're not already cached
        if (event.request.method === 'GET' && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      });
    }).catch(() => {
      // Return offline page if available
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
