// IndexedDB (blobs, library state) + localStorage (small prefs) helpers.
import { BOOK_CACHE } from './config.js';

const DB_NAME = 'reads';
const STORES = ['kv', 'files', 'covers'];
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => STORES.forEach((s) => req.result.objectStoreNames.contains(s) || req.result.createObjectStore(s));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  set: (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
};

export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('reads.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem('reads.' + key, JSON.stringify(val)); } catch { /* quota / private mode */ }
  },
  del(key) {
    try { localStorage.removeItem('reads.' + key); } catch { /* ignore */ }
  },
};

// ---- Offline book cache (shared with the service worker) ----
export function bookUrl(path) {
  return new URL(path.split('/').map(encodeURIComponent).join('/'), document.baseURI).href;
}

async function bookCache() {
  return 'caches' in self ? caches.open(BOOK_CACHE) : null;
}

export async function cachedBookBlob(path) {
  const c = await bookCache();
  const r = c && (await c.match(bookUrl(path)));
  return r ? r.blob() : null;
}

export async function putBookInCache(path, blob) {
  const c = await bookCache();
  if (!c) return;
  await c.put(bookUrl(path), new Response(blob, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(blob.size) },
  }));
}

export async function removeBookFromCache(path) {
  const c = await bookCache();
  if (c) await c.delete(bookUrl(path));
}

export async function cachedBookPaths() {
  const c = await bookCache();
  if (!c) return new Set();
  const reqs = await c.keys();
  const base = new URL('.', document.baseURI).href;
  return new Set(reqs.map((r) => decodeURIComponent(r.url.replace(base, ''))));
}

export async function clearBookCache() {
  if ('caches' in self) await caches.delete(BOOK_CACHE);
}
