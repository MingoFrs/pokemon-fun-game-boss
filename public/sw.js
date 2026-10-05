/* Service worker — Route du Boss
 * - Code/HTML (même origine) : réseau d'abord, repli cache (mises à jour toujours fraîches).
 * - Sprites Pokémon / dresseurs : cache d'abord, plafonné (MAX_SPRITES), purge des plus anciens.
 * - Polices Google : cache d'abord.
 * - /api/* statiques (sprite-ids, avatars, pokedex, évolutions) : cache + revalidation.
 * - Jamais interceptés : socket.io, autres /api (comptes, stats), requêtes non-GET.
 * Incrémenter VERSION pour purger tous les caches. */
const VERSION = 'v1';
const SHELL = 'rdb-shell-' + VERSION;
const SPRITES = 'rdb-sprites-' + VERSION;
const FONTS = 'rdb-fonts-' + VERSION;
const API = 'rdb-api-' + VERSION;
const KEEP = [SHELL, SPRITES, FONTS, API];
const MAX_SPRITES = 700;

const SPRITE_HOSTS = ['raw.githubusercontent.com', 'play.pokemonshowdown.com'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const API_CACHEABLE = ['/api/sprite-ids', '/api/avatars', '/api/pokedex/national', '/api/evolution-finals'];
const PRECACHE = ['/', '/manifest.json', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then(cache => Promise.allSettled(PRECACHE.map(u => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('rdb-') && !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Tente une requête CORS (réponse lisible, taille réelle en cache) ; repli sur la requête
// d'origine (réponse opaque, jamais mise en cache : une opaque pèse ~7 Mo de quota).
async function fetchCors(request) {
  try {
    const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) return { res, cacheable: true };
  } catch (e) {}
  return { res: await fetch(request), cacheable: false };
}

async function cacheFirstCors(event, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request.url);
  if (hit) return hit;
  const { res, cacheable } = await fetchCors(event.request);
  if (cacheable) {
    event.waitUntil(
      cache.put(event.request.url, res.clone()).then(() => max ? trim(cacheName, max) : null).catch(() => {})
    );
  }
  return res;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = (await cache.match(request, { ignoreSearch: false })) ||
      (fallbackUrl ? await cache.match(fallbackUrl, { ignoreSearch: true }) : null);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request).then(res => {
    if (res.ok) cache.put(event.request, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  if (hit) { event.waitUntil(refresh); return hit; }
  return (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/socket.io/')) return;
    if (url.pathname.startsWith('/api/')) {
      if (API_CACHEABLE.includes(url.pathname)) event.respondWith(staleWhileRevalidate(event, API));
      return;
    }
    if (url.pathname === '/sw.js') return;
    event.respondWith(networkFirst(req, SHELL, req.mode === 'navigate' ? '/' : null));
    return;
  }

  if (SPRITE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirstCors(event, SPRITES, MAX_SPRITES));
    return;
  }
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirstCors(event, FONTS, 0));
  }
});

// ---------- Notifications push (rappel du défi quotidien) ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Route du Boss', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'rdb-daily',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        client.postMessage({ type: 'open-daily' });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
