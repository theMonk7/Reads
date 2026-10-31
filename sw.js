// Offline support. Bump VERSION when shipping app changes.
const VERSION = 'v3';
const SHELL = `reads-shell-${VERSION}`;
const VENDOR = 'reads-vendor-v4.10.38';
const BOOKS = 'reads-books';

const SHELL_ASSETS = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/config.js',
  'js/store.js',
  'js/github.js',
  'js/library.js',
  'js/reader.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const VENDOR_ASSETS = ['vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    await (await caches.open(VENDOR)).addAll(VENDOR_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, VENDOR, BOOKS]);
    for (const k of await caches.keys()) if (k.startsWith('reads-') && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;

  if (path.endsWith('/library.json')) return; // app handles library freshness itself
  if (path.toLowerCase().endsWith('.pdf')) return e.respondWith(book(req));
  if (path.includes('/vendor/')) return e.respondWith(cacheFirst(req, VENDOR));
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, 'index.html'));
  e.respondWith(networkFirst(req));
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, fallback) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(req, { cache: 'no-cache' }), 4000);
    if (res.ok) cache.put(fallback || req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(fallback || req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error('offline');
  }
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

// Books: serve downloaded copies (including byte ranges for pdf.js), else network.
async function book(req) {
  const cache = await caches.open(BOOKS);
  const hit = await cache.match(req.url);
  if (!hit) return fetch(req);
  const range = req.headers.get('Range');
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return hit;
  const blob = await hit.blob();
  const start = +m[1];
  const end = m[2] ? Math.min(+m[2], blob.size - 1) : blob.size - 1;
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
