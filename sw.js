// Service worker for the new-tab page: availability, not speed.
//
// Strategy is network-first for every same-origin GET. While the server
// is up this worker adds nothing but a copy of each successful response
// into CacheStorage; the page's freshness rules (no-cache revalidation,
// the editor's staleness guard) all still apply because every request
// really goes to the server. When the server is DOWN - the documented
// "new tab is blank, go check systemctl" failure mode - the last good
// copy of everything is served instead, so the tab still works.
//
// Deliberately NOT cache-first: serving cached HTML/JS while the server
// is up is exactly the stale-editor-code hazard from 2026-08-21.

const CACHE = 'newtab-fallback-v1';
const PRECACHE = ['/', '/index.html', '/style.css', '/app.js', '/bookmarks.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Best effort: a miss here just means no fallback until the file
      // is first fetched by a page.
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // PUT /bookmarks.json and any cross-origin traffic (weather, favicon
  // fallback) pass straight through untouched.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then((res) => {
      // Only overwrite the fallback with full, successful responses.
      // 304s flow back to the page (its cache handles them) but must not
      // clobber a cached 200.
      if (res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() =>
      caches.match(req, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        return new Response('new-tab server is down and nothing is cached yet',
          { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
    )
  );
});
