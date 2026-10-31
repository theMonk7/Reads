// Library state = last known remote library.json + a queue of local edits (ops).
// Edits apply instantly offline; sync() rebases the queue on the latest remote
// copy and commits everything (PDFs + library.json) to GitHub in one commit.
import { LIBRARY_PATH, BOOKS_DIR, detectRepo } from './config.js';
import { idb, prefs, putBookInCache, removeBookFromCache } from './store.js';
import { GitHub } from './github.js';

const EMPTY = { version: 1, rev: 0, categories: [], books: [] };
const listeners = new Set();

let remote = EMPTY;
let ops = [];
let view = EMPTY;
let syncing = null;

export const library = {
  get data() { return view; },
  get pending() { return ops.length; },
  get syncing() { return !!syncing; },
  book: (id) => view.books.find((b) => b.id === id),
  category: (id) => view.categories.find((c) => c.id === id),
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function emit() { listeners.forEach((fn) => fn(view)); }

function rebuild() {
  view = applyOps(remote, ops);
  emit();
}

export function applyOps(base, list) {
  const lib = structuredClone(base);
  lib.categories ||= [];
  lib.books ||= [];
  for (const op of list) {
    switch (op.t) {
      case 'addCat':
        if (!lib.categories.some((c) => c.id === op.id)) lib.categories.push({ id: op.id, name: op.name });
        break;
      case 'renameCat': {
        const c = lib.categories.find((x) => x.id === op.id);
        if (c) c.name = op.name;
        break;
      }
      case 'moveCat': {
        const i = lib.categories.findIndex((x) => x.id === op.id);
        const j = i + op.dir;
        if (i >= 0 && j >= 0 && j < lib.categories.length) [lib.categories[i], lib.categories[j]] = [lib.categories[j], lib.categories[i]];
        break;
      }
      case 'delCat':
        lib.categories = lib.categories.filter((c) => c.id !== op.id);
        lib.books.forEach((b) => { if (b.category === op.id) b.category = null; });
        break;
      case 'addBook':
        if (!lib.books.some((b) => b.id === op.book.id)) lib.books.push({ ...op.book });
        break;
      case 'editBook': {
        const b = lib.books.find((x) => x.id === op.id);
        if (b) Object.assign(b, op.patch);
        break;
      }
      case 'delBook':
        lib.books = lib.books.filter((b) => b.id !== op.id);
        break;
    }
  }
  return lib;
}

async function persist() {
  await idb.set('kv', 'remote', remote);
  await idb.set('kv', 'ops', ops);
}

// ---------- Loading ----------
export async function loadLibrary() {
  remote = (await idb.get('kv', 'remote').catch(() => null)) || EMPTY;
  ops = (await idb.get('kv', 'ops').catch(() => null)) || [];
  rebuild();
  refreshRemote();
}

export async function refreshRemote() {
  if (!navigator.onLine) return;
  let fresh = null;
  const gh = github();
  if (gh) {
    try { fresh = JSON.parse(await gh.readFile(LIBRARY_PATH)); } catch { /* fall back to Pages copy */ }
  }
  if (!fresh) {
    try {
      const r = await fetch(`${LIBRARY_PATH}?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) fresh = await r.json();
    } catch { /* offline */ }
  }
  // GitHub Pages can lag behind a fresh commit — never go backwards.
  if (fresh && (fresh.rev || 0) >= (remote.rev || 0)) {
    remote = fresh;
    await persist();
    rebuild();
  }
}

// ---------- Settings / client ----------
export function repoSettings() {
  return { ...detectRepo(), ...prefs.get('repo', {}) };
}
export function saveRepoSettings(s) { prefs.set('repo', s); }
export function getToken() { return prefs.get('token', ''); }
export function setToken(t) {
  if (t !== getToken()) prefs.del('account');
  t ? prefs.set('token', t) : prefs.del('token');
}

// Last verified sign-in, cached so the badge still shows offline.
// { login, repo, ok, checked } — ok:false means GitHub rejected the token.
export function getAccount() {
  return getToken() ? prefs.get('account', null) : null;
}

export async function verifyAccount(token = getToken()) {
  if (!token) { prefs.del('account'); return null; }
  if (!navigator.onLine) return getAccount();
  const gh = github(token);
  const prev = getAccount();
  try {
    await gh.check();
    const me = await gh.user().catch(() => null);
    const account = { login: me?.login || prev?.login || '', repo: `${gh.owner}/${gh.repo}`, ok: true, checked: new Date().toISOString() };
    prefs.set('account', account);
    return account;
  } catch (e) {
    if (!e.status) return prev; // network failure: keep the cached state
    const account = { ...prev, repo: `${gh.owner}/${gh.repo}`, ok: false, error: e.message, checked: new Date().toISOString() };
    prefs.set('account', account);
    return account;
  }
}

export function github(token = getToken()) {
  return token ? new GitHub({ ...repoSettings(), token }) : null;
}

// ---------- Edits ----------
export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

async function push(op) {
  op.k = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  ops.push(op);
  rebuild(); // update the view first so callers can use the result right away
  await persist();
  scheduleSync();
}

export function addCategory(name) {
  const id = uniqueId(slugify(name), new Set(view.categories.map((c) => c.id)));
  push({ t: 'addCat', id, name: name.trim() });
  return id;
}
export const renameCategory = (id, name) => push({ t: 'renameCat', id, name: name.trim() });
export const moveCategory = (id, dir) => push({ t: 'moveCat', id, dir });
export const deleteCategory = (id) => push({ t: 'delCat', id });
export const editBook = (id, patch) => push({ t: 'editBook', id, patch });

export async function addBook({ file, title, author, category }) {
  const ids = new Set(view.books.map((b) => b.id));
  const paths = new Set(view.books.map((b) => b.path));
  const id = uniqueId(slugify(title), ids);
  let path = `${BOOKS_DIR}/${id}.pdf`;
  for (let n = 2; paths.has(path); n++) path = `${BOOKS_DIR}/${id}-${n}.pdf`;
  const book = { id, title: title.trim(), author: (author || '').trim(), path, category: category || null, size: file.size, added: new Date().toISOString() };
  await idb.set('files', id, file);
  await push({ t: 'addBook', book });
  return book;
}

export async function deleteBook(id) {
  const book = library.book(id);
  if (!book) return;
  const unsynced = ops.some((o) => o.t === 'addBook' && o.book.id === id);
  if (unsynced) {
    // Never reached GitHub: drop its queued ops instead of queueing a delete.
    ops = ops.filter((o) => !((o.t === 'addBook' && o.book.id === id) || (o.t === 'editBook' && o.id === id)));
    await persist();
    rebuild();
  } else {
    await push({ t: 'delBook', id, path: book.path });
  }
  await idb.del('files', id).catch(() => {});
  await idb.del('covers', id).catch(() => {});
  await removeBookFromCache(book.path).catch(() => {});
}

export function isPendingBook(id) {
  return ops.some((o) => o.t === 'addBook' && o.book.id === id);
}

// ---------- Sync ----------
let syncTimer;
function scheduleSync() {
  clearTimeout(syncTimer);
  if (getToken() && navigator.onLine) syncTimer = setTimeout(() => sync().catch(() => {}), 1200);
}

export function sync() {
  if (syncing) return syncing;
  if (!ops.length) return Promise.resolve(false);
  const gh = github();
  if (!gh) return Promise.reject(new Error('Add a GitHub token in Settings to sync.'));
  if (!navigator.onLine) return Promise.reject(new Error('Offline — changes will sync when you reconnect.'));
  syncing = doSync(gh).finally(() => { syncing = null; emit(); });
  emit();
  return syncing;
}

async function doSync(gh, attempt = 0) {
  const batch = ops.slice();
  const head = await gh.headCommit();
  const text = await gh.readFile(LIBRARY_PATH);
  const base = text ? JSON.parse(text) : EMPTY;
  const next = applyOps(base, batch);
  next.rev = (base.rev || 0) + 1;
  next.updated = new Date().toISOString();

  const entries = [];
  const uploaded = [];
  for (const op of batch) {
    if (op.t !== 'addBook' || !next.books.some((b) => b.id === op.book.id)) continue;
    const file = await idb.get('files', op.book.id);
    if (!file) continue;
    entries.push({ path: op.book.path, sha: await gh.createBlob(file) });
    uploaded.push({ id: op.book.id, path: op.book.path, file });
  }
  const basePaths = new Set((base.books || []).map((b) => b.path));
  for (const op of batch) {
    if (op.t === 'delBook' && basePaths.has(op.path) && !next.books.some((b) => b.path === op.path)) {
      entries.push({ path: op.path, delete: true });
    }
  }
  entries.push({ path: LIBRARY_PATH, content: JSON.stringify(next, null, 2) + '\n' });

  try {
    await gh.commit(entries, commitMessage(batch), head);
  } catch (e) {
    // Someone else moved the branch between read and write — rebase once.
    if (e.status === 422 && attempt < 2) return doSync(gh, attempt + 1);
    throw e;
  }

  remote = next;
  const done = new Set(batch.map((o) => o.k));
  ops = ops.filter((o) => !done.has(o.k));
  await persist();
  for (const u of uploaded) {
    await putBookInCache(u.path, u.file).catch(() => {});
    await idb.del('files', u.id);
  }
  rebuild();
  return true;
}

function commitMessage(batch) {
  const added = batch.filter((o) => o.t === 'addBook').map((o) => o.book.title);
  const removed = batch.filter((o) => o.t === 'delBook').length;
  const parts = [];
  if (added.length) parts.push(`Add ${added.length === 1 ? `"${added[0]}"` : `${added.length} books`}`);
  if (removed) parts.push(`remove ${removed} book${removed > 1 ? 's' : ''}`);
  const other = batch.length - added.length - removed;
  if (other) parts.push(`${other} library edit${other > 1 ? 's' : ''}`);
  const msg = parts.join(', ');
  return 'Reads: ' + msg.charAt(0).toLowerCase() + msg.slice(1);
}

addEventListener('online', () => { refreshRemote(); scheduleSync(); });
