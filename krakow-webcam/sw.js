const CACHE_PREFIX = 'krakow-webcam-';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX))
        .map((name) => caches.delete(name))
    );

    try {
      await self.registration.unregister();
    } catch {
      // Ignore unregister errors during cleanup.
    }

    const clients = await self.clients.matchAll({ type: 'window' });
    await Promise.all(clients.map(async (client) => {
      try {
        await client.navigate(client.url);
      } catch {
        // Ignore navigation failures for transient clients.
      }
    }));
  })());
});
