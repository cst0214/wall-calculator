// Offline support for the beta: always try the network first (so test changes show up at once),
// fall back to the cached copy when offline. Only this beta's own caches are ever deleted.
const PREFIX = 'wall-calc-beta-';
const CACHE = `${PREFIX}v1`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/ar.js', 'js/calc.js', 'js/catalog.js', 'js/editor.js', 'js/geometry.js', 'js/photo.js', 'js/render.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      throw new Error('offline');
    }
  }));
});
