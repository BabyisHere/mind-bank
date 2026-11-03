// App shell: serve from cache instantly, refresh in the background (new code shows on the next open).
// Fonts and pinned CDN modules: cache first, their URLs never change. Supabase data always goes to the network.
const CACHE = 'mindbank-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'logic.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];
const CDN = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    }));
  } else if (CDN.includes(u.hostname)) {
    e.respondWith(caches.open(CACHE).then(async c => (await c.match(e.request)) ||
      fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; })));
  }
});
