/*
 * Service worker: what lets the app be installed on a PC (Chrome/Edge) and open even without a connection.
 * - The app page: always fetched fresh from the network, so updates show at once; the last copy is only used offline.
 * - Files under /assets: have the version in their name, so a stored copy is always right.
 * - /api: never touched. Your numbers always come straight from the server.
 */
const CACHE = 'budsjett-v1';

self.addEventListener('install', (event) => {
  // Keep a copy of the app page from the start, so it opens offline right after installing.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add('/'))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || new Response('Ingen nettilkobling.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
