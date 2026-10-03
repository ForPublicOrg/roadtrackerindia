/**
 * RoadTracker's service worker. It does one thing: when a page cannot be
 * fetched because the phone is offline, it answers with a small "you're
 * offline" page instead of the browser's own error — which, inside an installed
 * app with no address bar, looks like the app itself has crashed.
 *
 * Nothing else is cached, on purpose. The bundle, the road data and the map
 * tiles always come from the network, so a deploy can never be hidden behind a
 * stale copy, and there is no cache to grow on a phone short of storage.
 * Bump CACHE when offline.html changes.
 */
const CACHE = 'rti-offline-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('rti-') && key !== CACHE) await caches.delete(key)
      }
      // start the page's request while the worker boots, so being in the path
      // of every navigation costs nothing when the network is fine
      await self.registration.navigationPreload?.enable()
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  // pages only — data, tiles and the API pass straight through untouched
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) || (await fetch(event.request))
      } catch {
        return (await caches.match(OFFLINE_URL)) || Response.error()
      }
    })(),
  )
})
