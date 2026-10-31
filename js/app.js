import { MAX_UPLOAD_BYTES } from './config.js';
import { idb, prefs, bookUrl, cachedBookBlob, putBookInCache, removeBookFromCache, cachedBookPaths, clearBookCache } from './store.js';
import {
  library, loadLibrary, refreshRemote, sync, github, getToken, setToken, repoSettings, saveRepoSettings, getAccount, verifyAccount,
  addCategory, renameCategory, moveCategory, deleteCategory, addBook, editBook, deleteBook, isPendingBook,
} from './library.js';
import { Reader, renderCover } from './reader.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  more: icon('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  play: icon('<path d="M7 4.5v15l12-7.5-12-7.5Z"/>'),
  offline: icon('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  check: icon('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  edit: icon('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>'),
  folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>'),
  trash: icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  up: icon('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: icon('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  cloud: icon('<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8H7Z"/>'),
};

const state = {
  filter: prefs.get('filter', 'all'),
  query: '',
  cached: new Set(),
  covers: new Map(),       // bookId -> objectURL
  readerBook: null,
};

// =============== Toasts ===============
function toast(msg, { error = false, ms = 3200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// =============== Theme ===============
const THEMES = ['auto', 'light', 'sepia', 'dark', 'black'];
function applyTheme(t = prefs.get('theme', 'auto')) {
  document.documentElement.dataset.theme = t;
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
  $$('#appThemeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
}
$('#themeBtn').onclick = () => {
  const t = THEMES[(THEMES.indexOf(prefs.get('theme', 'auto')) + 1) % THEMES.length];
  prefs.set('theme', t);
  applyTheme(t);
  toast(`Theme: ${t}`, { ms: 1200 });
};

// =============== Progress ===============
const progress = {
  all: () => prefs.get('progress', {}),
  get: (id) => progress.all()[id],
  set(id, rec) {
    const all = progress.all();
    all[id] = { ...all[id], ...rec, t: Date.now() };
    prefs.set('progress', all);
    prefs.set('last', id);
  },
  pct: (id) => {
    const p = progress.get(id);
    return p?.pages ? Math.round((p.page / p.pages) * 100) : 0;
  },
};

function recentBooks() {
  const all = progress.all();
  return library.data.books
    .filter((b) => all[b.id])
    .sort((a, b) => all[b.id].t - all[a.id].t);
}

// =============== Covers ===============
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }

function coverHtml(book) {
  const url = state.covers.get(book.id);
  if (url) return `<div class="cover" data-cover="${esc(book.id)}"><img src="${url}" alt="" loading="lazy"></div>`;
  const h = hue(book.title);
  return `<div class="cover gen" data-cover="${esc(book.id)}" style="background:linear-gradient(160deg,hsl(${h} 45% 42%),hsl(${(h + 40) % 360} 50% 26%))">
    <div class="cover-title">${esc(book.title)}</div><div class="cover-author">${esc(book.author)}</div></div>`;
}

async function loadStoredCovers() {
  const ids = await idb.keys('covers').catch(() => []);
  await Promise.all(ids.map(async (id) => {
    const blob = await idb.get('covers', id);
    if (blob) state.covers.set(id, URL.createObjectURL(blob));
  }));
}

const coverQueue = [];
let coverBusy = false;
const coverObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    coverObserver.unobserve(e.target);
    const id = e.target.dataset.cover;
    if (!state.covers.has(id) && !coverQueue.includes(id)) coverQueue.push(id);
  }
  pumpCovers();
}, { rootMargin: '200px' });

async function pumpCovers() {
  if (coverBusy || !coverQueue.length) return;
  coverBusy = true;
  const id = coverQueue.shift();
  const book = library.book(id);
  try {
    if (book && !state.covers.has(id)) {
      const src = await bookSource(book, { allowRange: true }).catch(() => null);
      if (src) await setCover(id, await renderCover(src));
    }
  } catch (e) { console.warn('cover', id, e); }
  coverBusy = false;
  pumpCovers();
}

async function setCover(id, blob) {
  if (!blob) return;
  await idb.set('covers', id, blob).catch(() => {});
  state.covers.set(id, URL.createObjectURL(blob));
  $$(`[data-cover="${CSS.escape(id)}"]`).forEach((el) => {
    el.classList.remove('gen');
    el.removeAttribute('style');
    el.innerHTML = `<img src="${state.covers.get(id)}" alt="">`;
  });
}

// =============== Book bytes (offline-first) ===============
async function bookSource(book, { allowRange = false, onProgress } = {}) {
  const pending = await idb.get('files', book.id).catch(() => null);
  if (pending) return { data: new Uint8Array(await pending.arrayBuffer()) };
  const cached = await cachedBookBlob(book.path).catch(() => null);
  if (cached) return { data: new Uint8Array(await cached.arrayBuffer()) };
  if (!navigator.onLine) throw new Error('This book isn’t downloaded for offline reading.');
  if (allowRange) return { url: bookUrl(book.path) };
  const blob = await downloadBook(book, onProgress);
  return { data: new Uint8Array(await blob.arrayBuffer()) };
}

async function downloadBook(book, onProgress) {
  let blob = null;
  const res = await fetch(bookUrl(book.path), { cache: 'no-cache' }).catch(() => null);
  if (res?.ok) blob = await readWithProgress(res, onProgress);
  // Freshly committed books may not be on GitHub Pages yet — fall back to the API.
  if (!blob && github()) blob = await github().readFile(book.path, 'blob');
  if (!blob) throw new Error('Could not download this book.');
  await putBookInCache(book.path, blob).catch(() => {});
  state.cached.add(book.path);
  return blob;
}

async function readWithProgress(res, onProgress) {
  const total = +res.headers.get('Content-Length') || 0;
  if (!res.body || !total || !onProgress) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got / total);
  }
  return new Blob(chunks, { type: 'application/pdf' });
}

const isOffline = (book) => state.cached.has(book.path) || isPendingBook(book.id);

// =============== Library rendering ===============
function renderLibrary() {
  const { books, categories } = library.data;
  const q = state.query.trim().toLowerCase();
  const match = (b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q);
  const catIds = new Set(categories.map((c) => c.id));
  const uncategorized = books.filter((b) => !catIds.has(b.category));
  if (state.filter !== 'all' && state.filter !== 'none' && !catIds.has(state.filter)) state.filter = 'all';

  // Continue reading
  const recent = recentBooks();
  const last = recent[0];
  $('#continueSection').hidden = !last || !!q;
  if (last) {
    const p = progress.get(last.id);
    const pct = progress.pct(last.id);
    $('#continueCard').innerHTML = `
      ${coverHtml(last)}
      <div>
        <h2>${esc(last.title)}</h2>
        <div class="meta">${esc(last.author || library.category(last.category)?.name || '')}</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="progress-text">Page ${p.page} of ${p.pages} · ${pct}% · ${timeAgo(p.t)}</div>
        <div class="actions"><button class="primary-btn" data-act="resume">${ICONS.play}<span>Resume</span></button></div>
      </div>`;
    $('#continueCard').onclick = () => openBook(last.id);
    $('#recentRow').innerHTML = recent.slice(1, 8).map((b) => `
      <div class="recent-item" data-open="${esc(b.id)}">${coverHtml(b)}
        <div style="min-width:0"><div class="t">${esc(b.title)}</div><div class="s">${progress.pct(b.id)}% read</div></div></div>`).join('');
  }

  // Sections drawer
  const count = (id) => books.filter((b) => (id === 'none' ? !catIds.has(b.category) : b.category === id)).length;
  const chips = [{ id: 'all', name: 'All', n: books.length }, ...categories.map((c) => ({ ...c, n: count(c.id) }))];
  if (uncategorized.length) chips.push({ id: 'none', name: 'Unsorted', n: uncategorized.length });
  $('#categoryChips').innerHTML = chips.map((c) =>
    `<button class="drawer-item ${state.filter === c.id ? 'on' : ''}" data-filter="${esc(c.id)}" ${state.filter === c.id ? 'aria-current="true"' : ''}>
      <span class="name">${esc(c.name)}</span><span class="n">${c.n}</span></button>`).join('');

  // Sections
  let groups = categories.map((c) => ({ ...c, books: books.filter((b) => b.category === c.id) }));
  if (uncategorized.length) groups.push({ id: 'none', name: 'Unsorted', books: uncategorized, virtual: true });
  if (state.filter !== 'all') groups = groups.filter((g) => g.id === state.filter);
  let shown = 0;
  $('#sections').innerHTML = groups.map((g) => {
    const list = g.books.filter(match).sort((a, b) => a.title.localeCompare(b.title));
    shown += list.length;
    if (q && !list.length) return '';
    return `<section class="section">
      <div class="section-head"><h3>${esc(g.name)}</h3><span class="count">${list.length}</span>
        ${g.virtual ? '' : `<button class="icon-btn" data-catmenu="${esc(g.id)}" aria-label="Section options">${ICONS.more}</button>`}</div>
      ${list.length ? `<div class="grid">${list.map(bookCard).join('')}</div>`
        : `<div class="empty-section" data-addto="${esc(g.id)}">${ICONS.plus}<span>Add books to ${esc(g.name)}</span></div>`}
    </section>`;
  }).join('');
  $('#emptyState').hidden = shown > 0 || !q;

  $$('[data-cover]').forEach((el) => { if (!state.covers.has(el.dataset.cover)) coverObserver.observe(el); });
  updateSyncUi();
}

function bookCard(b) {
  const pct = progress.pct(b.id);
  const pending = isPendingBook(b.id);
  return `<article class="book" tabindex="0" data-open="${esc(b.id)}">
    ${coverHtml(b)}
    <div class="badges">
      ${pending ? `<span class="badge pending" title="Not yet uploaded to GitHub">${ICONS.cloud}Local</span>`
        : isOffline(b) ? `<span class="badge" title="Available offline">${ICONS.check}Offline</span>` : ''}
    </div>
    <button class="icon-btn more" data-bookmenu="${esc(b.id)}" aria-label="Book options">${ICONS.more}</button>
    <div class="info">
      <div class="title">${esc(b.title)}</div>
      <div class="author">${esc(b.author || '')}</div>
      ${pct ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
    </div>
  </article>`;
}

function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

// Delegated library clicks
$('#libraryView').addEventListener('click', (e) => {
  const t = e.target;
  const bm = t.closest('[data-bookmenu]');
  if (bm) { e.stopPropagation(); return bookMenu(bm.dataset.bookmenu, bm); }
  const cm = t.closest('[data-catmenu]');
  if (cm) return categoryMenu(cm.dataset.catmenu, cm);
  const add = t.closest('[data-addto]');
  if (add) return openUpload([], add.dataset.addto);
  const open = t.closest('[data-open]');
  if (open) return openBook(open.dataset.open);
});
$('#libraryView').addEventListener('keydown', (e) => {
  const open = e.target.closest?.('[data-open]');
  if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openBook(open.dataset.open); }
});
$('#searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderLibrary(); });

// =============== Menus ===============
function showMenu(anchor, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.label && !it.fn
    ? `<div class="menu-label">${esc(it.label)}</div>`
    : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon || ''}<span>${esc(it.text)}</span></button>`).join('');
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
  m.style.top = `${r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  m.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].fn();
  };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  function outside(e) { if (!m.contains(e.target)) closeMenu(); }
  function closeMenu() { m.hidden = true; document.removeEventListener('pointerdown', outside, true); }
  m.close = closeMenu;
}

function bookMenu(id, anchor) {
  const b = library.book(id);
  if (!b) return;
  const cats = library.data.categories.filter((c) => c.id !== b.category);
  showMenu(anchor, [
    { text: 'Read', icon: ICONS.play, fn: () => openBook(id) },
    { text: 'Edit details', icon: ICONS.edit, fn: () => editBookDialog(b) },
    ...(cats.length ? ['-', { label: 'Move to' }, ...cats.map((c) => ({ text: c.name, icon: ICONS.folder, fn: () => { editBook(id, { category: c.id }); toast(`Moved to ${c.name}`); } }))] : []),
    { text: 'New section…', icon: ICONS.plus, fn: async () => {
      const v = await prompt('New section', [{ name: 'name', label: 'Name', placeholder: 'e.g. System Design' }]);
      if (v?.name?.trim()) editBook(id, { category: addCategory(v.name) });
    } },
    '-',
    isPendingBook(id) ? null
      : state.cached.has(b.path)
        ? { text: 'Remove download', icon: ICONS.trash, fn: async () => { await removeBookFromCache(b.path); state.cached.delete(b.path); renderLibrary(); } }
        : { text: 'Download for offline', icon: ICONS.offline, fn: () => downloadForOffline([b]) },
    { text: 'Delete book', icon: ICONS.trash, danger: true, fn: async () => {
      const v = await prompt(`Delete “${b.title}”?`, [], { okText: 'Delete', note: isPendingBook(id) ? 'It hasn’t been uploaded yet, so it will be removed from this device.' : 'The PDF will be removed from your GitHub repo on next sync.' });
      if (v) { await deleteBook(id); toast('Book deleted'); }
    } },
  ].filter(Boolean));
}

function categoryMenu(id, anchor) {
  const c = library.category(id);
  if (!c) return;
  const idx = library.data.categories.indexOf(c);
  showMenu(anchor, [
    { text: 'Add books here', icon: ICONS.plus, fn: () => openUpload([], id) },
    { text: 'Rename', icon: ICONS.edit, fn: async () => {
      const v = await prompt('Rename section', [{ name: 'name', label: 'Name', value: c.name }]);
      if (v?.name?.trim()) renameCategory(id, v.name);
    } },
    idx > 0 && { text: 'Move up', icon: ICONS.up, fn: () => moveCategory(id, -1) },
    idx < library.data.categories.length - 1 && { text: 'Move down', icon: ICONS.down, fn: () => moveCategory(id, 1) },
    '-',
    { text: 'Delete section', icon: ICONS.trash, danger: true, fn: async () => {
      const v = await prompt(`Delete “${c.name}”?`, [], { okText: 'Delete', note: 'Books in it move to Unsorted — they are not deleted.' });
      if (v) deleteCategory(id);
    } },
  ].filter(Boolean));
}

// =============== Sections drawer ===============
const drawer = $('#sectionsDrawer');
$('#menuBtn').onclick = () => {
  if (drawer.open) return;
  if (drawer.showModal) drawer.showModal(); else drawer.setAttribute('open', '');
};
drawer.addEventListener('click', (e) => {
  // Backdrop clicks target the dialog itself but land outside its box.
  if (e.target === drawer) {
    const r = drawer.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) drawer.close();
    return;
  }
  const f = e.target.closest('[data-filter]');
  if (!f) return;
  state.filter = f.dataset.filter;
  prefs.set('filter', state.filter);
  drawer.close();
  renderLibrary();
  scrollTo({ top: 0 });
});

$('#newCategoryBtn').onclick = async () => {
  drawer.close();
  const v = await prompt('New section', [{ name: 'name', label: 'Name', placeholder: 'e.g. System Design' }]);
  if (v?.name?.trim()) {
    state.filter = addCategory(v.name);
    prefs.set('filter', state.filter);
    renderLibrary();
  }
};

async function editBookDialog(b) {
  const v = await prompt('Edit book', [
    { name: 'title', label: 'Title', value: b.title },
    { name: 'author', label: 'Author', value: b.author || '' },
    { name: 'category', label: 'Section', type: 'select', value: b.category || '', options: categoryOptions() },
  ]);
  if (!v || !v.title.trim()) return;
  editBook(b.id, { title: v.title.trim(), author: v.author.trim(), category: v.category || null });
}

function categoryOptions() {
  return [...library.data.categories.map((c) => ({ value: c.id, text: c.name })), { value: '', text: 'Unsorted' }];
}

// =============== Prompt dialog ===============
function prompt(title, fields, { okText = 'OK', note = '' } = {}) {
  const dlg = $('#promptDialog');
  $('#promptTitle').textContent = title;
  $('#promptOk').textContent = okText;
  $('#promptOk').classList.toggle('danger', okText === 'Delete');
  $('#promptFields').innerHTML = (note ? `<p class="hint">${esc(note)}</p>` : '') + fields.map((f) => `
    <label>${esc(f.label)}
      ${f.type === 'select'
        ? `<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.text)}</option>`).join('')}</select>`
        : `<input name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`}
    </label>`).join('');
  dlg.returnValue = '';
  dlg.showModal();
  $('#promptFields input')?.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(fields.map((f) => [f.name, $(`[name="${f.name}"]`, dlg).value])));
    }, { once: true });
  });
}

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cancel]');
  if (c) c.closest('dialog').close('cancel');
});

// =============== Upload ===============
let uploadFiles = [];
function openUpload(files = [], categoryId) {
  uploadFiles = [];
  $('#uploadList').innerHTML = '';
  const sel = $('#uploadCategory');
  sel.innerHTML = categoryOptions().map((o) => `<option value="${esc(o.value)}">${esc(o.text)}</option>`).join('') + '<option value="__new">+ New section…</option>';
  const pick = categoryId ?? (state.filter !== 'all' && state.filter !== 'none' ? state.filter : library.data.categories[0]?.id);
  if (pick != null) sel.value = pick === 'none' ? '' : pick;
  $('#uploadHint').textContent = getToken()
    ? 'Books are saved on this device right away and committed to GitHub in the background.'
    : 'No GitHub token yet — books stay on this device until you add one in Settings.';
  addUploadFiles(files);
  $('#uploadDialog').returnValue = '';
  $('#uploadDialog').showModal();
}

function titleFromFilename(name) {
  return name.replace(/\.pdf$/i, '').replace(/[-_+.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

function addUploadFiles(files) {
  for (const f of files) {
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { toast(`${f.name} isn’t a PDF`, { error: true }); continue; }
    if (f.size > MAX_UPLOAD_BYTES) { toast(`${f.name} is over 95 MB — GitHub can’t store it`, { error: true }); continue; }
    uploadFiles.push(f);
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.innerHTML = `<input class="title-in" value="${esc(titleFromFilename(f.name))}" aria-label="Title">
      <input class="author-in" placeholder="Author (optional)" aria-label="Author">
      <span class="size">${(f.size / 1048576).toFixed(1)} MB</span>`;
    $('#uploadList').append(row);
  }
  $('#uploadSubmit').disabled = !uploadFiles.length;
  $('#uploadSubmit').textContent = uploadFiles.length > 1 ? `Add ${uploadFiles.length} books` : 'Add';
}

$('#fileInput').onchange = (e) => { addUploadFiles([...e.target.files]); e.target.value = ''; };
$('#uploadBtn').onclick = () => openUpload();
$('#uploadCategory').onchange = async (e) => {
  if (e.target.value !== '__new') return;
  const v = await prompt('New section', [{ name: 'name', label: 'Name', placeholder: 'e.g. System Design' }]);
  const name = v?.name?.trim();
  if (!name) { e.target.value = library.data.categories[0]?.id || ''; return; }
  const id = addCategory(name);
  e.target.insertAdjacentHTML('afterbegin', `<option value="${esc(id)}">${esc(name)}</option>`);
  e.target.value = id;
};
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
dz.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addUploadFiles([...e.dataTransfer.files]); });

$('#uploadDialog').addEventListener('close', async () => {
  if ($('#uploadDialog').returnValue !== 'ok' || !uploadFiles.length) return;
  const rows = $$('#uploadList .upload-row');
  const category = $('#uploadCategory').value === '__new' ? '' : $('#uploadCategory').value;
  const files = uploadFiles;
  uploadFiles = [];
  for (let i = 0; i < files.length; i++) {
    const title = $('.title-in', rows[i]).value.trim() || titleFromFilename(files[i].name);
    const author = $('.author-in', rows[i]).value;
    const book = await addBook({ file: files[i], title, author, category });
    renderCover({ data: new Uint8Array(await files[i].arrayBuffer()) }).then((b) => setCover(book.id, b)).catch(() => {});
  }
  toast(files.length > 1 ? `${files.length} books added` : 'Book added');
  if (!getToken()) toast('Add a GitHub token in Settings to upload them to your repo.', { ms: 5000 });
});

// Whole-page drag & drop
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files') || !$('#readerView').hidden || $('#uploadDialog').open) return;
  dragDepth++;
  $('#dropOverlay').hidden = false;
});
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  if ($('#uploadDialog').open || !$('#readerView').hidden) return;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) openUpload(files);
});

// =============== Sync UI ===============
function updateSyncUi() {
  const btn = $('#syncBtn');
  const n = library.pending;
  btn.hidden = !n && !library.syncing;
  btn.classList.toggle('busy', library.syncing);
  btn.classList.toggle('pending', n > 0);
  $('#syncLabel').textContent = library.syncing ? 'Syncing…' : `${n} to sync`;
  $('#netBadge').hidden = navigator.onLine;
  updateAccountUi();
}

// =============== Account badge ===============
function updateAccountUi() {
  const btn = $('#accountBtn');
  const a = getAccount();
  btn.hidden = !getToken();
  if (btn.hidden) return;
  const offline = !navigator.onLine;
  const bad = a?.ok === false;
  const who = a?.login ? `@${a.login}` : 'GitHub';
  btn.classList.toggle('offline', offline);
  btn.classList.toggle('bad', bad);
  $('#accountLabel').textContent = bad ? 'Sign in again' : who;
  btn.title = bad ? `${a.error || 'GitHub rejected the token.'} Open Settings to update it.`
    : offline ? `Signed in as ${who} · offline. Changes sync when you reconnect.`
    : `Signed in as ${who}${a?.repo ? ` · ${a.repo}` : ''}`;
  btn.setAttribute('aria-label', btn.title);
}
async function refreshAccount() {
  await verifyAccount().catch(() => {});
  updateAccountUi();
}
$('#accountBtn').onclick = () => openSettings();
addEventListener('online', refreshAccount);
$('#syncBtn').onclick = async () => {
  try {
    if (await sync()) toast('Synced with GitHub');
  } catch (e) {
    toast(e.message, { error: true, ms: 6000 });
    if (!getToken()) openSettings();
  }
};
addEventListener('online', updateSyncUi);
addEventListener('offline', updateSyncUi);

// =============== Settings ===============
function openSettings() {
  const s = repoSettings();
  $('#ghOwner').value = s.owner;
  $('#ghRepo').value = s.repo;
  $('#ghBranch').value = s.branch;
  $('#ghToken').value = getToken();
  $('#tokenStatus').textContent = '';
  applyTheme();
  updateStorageInfo();
  $('#settingsDialog').returnValue = '';
  $('#settingsDialog').showModal();
}
$('#settingsBtn').onclick = openSettings;
$('#appThemeSeg').onclick = (e) => {
  const b = e.target.closest('[data-theme]');
  if (!b) return;
  prefs.set('theme', b.dataset.theme);
  applyTheme(b.dataset.theme);
};
function readSettingsForm() {
  return {
    repo: { owner: $('#ghOwner').value.trim(), repo: $('#ghRepo').value.trim(), branch: $('#ghBranch').value.trim() || 'main' },
    token: $('#ghToken').value.trim(),
  };
}
$('#testTokenBtn').onclick = async () => {
  const { repo, token } = readSettingsForm();
  const st = $('#tokenStatus');
  if (!token) { st.className = 'hint err'; st.textContent = 'Enter a token first.'; return; }
  st.className = 'hint'; st.textContent = 'Checking…';
  try {
    saveRepoSettings(repo);
    await github(token).check();
    st.className = 'hint ok'; st.textContent = `✓ Can write to ${repo.owner}/${repo.repo}`;
    if (token === getToken()) refreshAccount();
  } catch (e) {
    st.className = 'hint err'; st.textContent = e.message;
  }
};
$('#clearTokenBtn').onclick = () => { $('#ghToken').value = ''; setToken(''); updateAccountUi(); $('#tokenStatus').textContent = 'Token removed from this browser.'; };
$('#settingsDialog').addEventListener('close', () => {
  if ($('#settingsDialog').returnValue !== 'ok') return;
  const { repo, token } = readSettingsForm();
  saveRepoSettings(repo);
  setToken(token);
  updateAccountUi();
  refreshAccount();
  if (token && library.pending) $('#syncBtn').click();
  else refreshRemote();
});

async function updateStorageInfo() {
  const el = $('#storageInfo');
  const books = library.data.books;
  const n = books.filter(isOffline).length;
  let usage = '';
  try {
    const est = await navigator.storage?.estimate();
    if (est) usage = ` · ${(est.usage / 1048576).toFixed(0)} MB used of ${(est.quota / 1073741824).toFixed(1)} GB available`;
  } catch { /* unsupported */ }
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  el.textContent = `${n} of ${books.length} books available offline${usage}.${persisted ? ' Storage is persistent.' : ''}`;
}

$('#offlineAllBtn').onclick = () => downloadForOffline(library.data.books.filter((b) => !isOffline(b)));
$('#clearOfflineBtn').onclick = async () => {
  await clearBookCache();
  state.cached = await cachedBookPaths();
  renderLibrary();
  updateStorageInfo();
  toast('Downloads removed (books not yet uploaded are kept).');
};

async function downloadForOffline(books) {
  if (!books.length) return toast('Everything is already offline.');
  if (!navigator.onLine) return toast('You’re offline.', { error: true });
  navigator.storage?.persist?.().catch(() => {});
  const t = toast(`Downloading 0/${books.length}…`, { ms: 600000 });
  let ok = 0;
  for (const [i, b] of books.entries()) {
    t.textContent = `Downloading ${i + 1}/${books.length}: ${b.title}`;
    try {
      const blob = await downloadBook(b);
      ok++;
      if (!state.covers.has(b.id)) renderCover({ data: new Uint8Array(await blob.arrayBuffer()) }).then((c) => setCover(b.id, c)).catch(() => {});
    } catch (e) { console.warn(e); }
  }
  t.remove();
  toast(`${ok} book${ok === 1 ? '' : 's'} ready offline${ok < books.length ? ` · ${books.length - ok} failed` : ''}`);
  renderLibrary();
  if ($('#settingsDialog').open) updateStorageInfo();
}

// =============== Reader ===============
const readerView = $('#readerView');
const DEFAULT_DISPLAY = { tone: 'normal', brightness: 100, warmth: 0, contrast: 100, mode: 'scroll', fit: 'width', bg: 'auto' };
const PRESETS = {
  day: { tone: 'normal', brightness: 100, warmth: 0, contrast: 100, bg: 'auto' },
  paper: { tone: 'sepia', brightness: 100, warmth: 8, contrast: 100, bg: 'sepia' },
  evening: { tone: 'sepia', brightness: 88, warmth: 30, contrast: 100, bg: 'dark' },
  night: { tone: 'night', brightness: 85, warmth: 22, contrast: 95, bg: 'black' },
};
const TONE_FILTER = {
  normal: '',
  sepia: 'sepia(.5) saturate(1.1)',
  gray: 'grayscale(1)',
  dark: 'invert(.92) hue-rotate(180deg)',
  night: 'invert(.9) hue-rotate(180deg) sepia(.45)',
};
let display = { ...DEFAULT_DISPLAY, ...prefs.get('display', {}) };

function applyDisplay() {
  prefs.set('display', display);
  const f = [TONE_FILTER[display.tone], display.brightness !== 100 && `brightness(${display.brightness / 100})`, display.contrast !== 100 && `contrast(${display.contrast / 100})`].filter(Boolean).join(' ');
  readerView.style.setProperty('--page-filter', f || 'none');
  $('#warmth').style.opacity = display.warmth / 100;
  const darkTone = display.tone === 'dark' || display.tone === 'night';
  readerView.dataset.bg = display.bg === 'auto' ? (darkTone ? 'dark' : '') : display.bg;
  $('#brightness').value = display.brightness; $('#brightnessOut').textContent = `${display.brightness}%`;
  $('#warmthRange').value = display.warmth; $('#warmthOut').textContent = display.warmth ? `${display.warmth}%` : 'Off';
  $('#contrast').value = display.contrast; $('#contrastOut').textContent = `${display.contrast}%`;
  $$('#toneSeg [data-tone]').forEach((b) => b.classList.toggle('on', b.dataset.tone === display.tone));
  $$('#modeSeg [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === display.mode));
  $$('#bgSeg [data-bg]').forEach((b) => b.classList.toggle('on', b.dataset.bg === display.bg));
  $$('#presetSeg [data-preset]').forEach((b) => b.classList.toggle('on', Object.entries(PRESETS[b.dataset.preset]).every(([k, v]) => display[k] === v)));
  updateFitUi();
}

function updateFitUi() {
  const fit = reader.fit;
  $$('#fitSeg [data-fit]').forEach((b) => b.classList.toggle('on', b.dataset.fit === fit));
  $('#zoomLabel').textContent = `${Math.round(reader.scale * 100)}%`;
}

$('#presetSeg').onclick = (e) => { const p = e.target.closest('[data-preset]'); if (p) { display = { ...display, ...PRESETS[p.dataset.preset] }; applyDisplay(); } };
$('#toneSeg').onclick = (e) => { const b = e.target.closest('[data-tone]'); if (b) { display.tone = b.dataset.tone; applyDisplay(); } };
$('#bgSeg').onclick = (e) => { const b = e.target.closest('[data-bg]'); if (b) { display.bg = b.dataset.bg; applyDisplay(); } };
$('#modeSeg').onclick = (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  display.mode = b.dataset.mode;
  if (display.mode === 'paged' && reader.fit === 'width') reader.fit = 'page';
  reader.setMode(display.mode);
  applyDisplay();
};
$('#fitSeg').onclick = (e) => { const b = e.target.closest('[data-fit]'); if (b && b.dataset.fit !== 'custom') { display.fit = b.dataset.fit; reader.setFit(b.dataset.fit); applyDisplay(); } };
for (const [id, key] of [['brightness', 'brightness'], ['warmthRange', 'warmth'], ['contrast', 'contrast']]) {
  $('#' + id).oninput = (e) => { display[key] = +e.target.value; applyDisplay(); };
}
$('#resetDisplay').onclick = () => { display = { ...DEFAULT_DISPLAY, mode: display.mode }; reader.setFit(display.mode === 'paged' ? 'page' : 'width'); applyDisplay(); };

let saveTimer;
const reader = new Reader({
  root: readerView,
  viewer: $('#viewer'),
  pages: $('#pages'),
  onPage: (n, { scale, fit }) => {
    $('#pageNum').textContent = n;
    $('#pageSlider').value = n;
    $('#bookmarkBtn').classList.toggle('on', bookmarks.has(n));
    updateFitUi();
    highlightOutline(n);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProgress(scale, fit), 350);
  },
  onTap: () => toggleChrome(),
});

function saveProgress(scale = reader.scale, fit = reader.fit) {
  const b = state.readerBook;
  if (!b || !reader.numPages) return;
  const pos = reader.position();
  progress.set(b.id, { page: pos.page, offset: pos.offset, pages: reader.numPages, fit, scale: fit === 'custom' ? scale : undefined });
  $('#readerSub').textContent = `${Math.round((pos.page / reader.numPages) * 100)}% · ${library.category(b.category)?.name || 'Unsorted'}`;
}

async function openBook(id) {
  if (location.hash !== `#/read/${id}`) {
    history.pushState({ reader: true }, '', `#/read/${encodeURIComponent(id)}`);
  }
  await showReader(id);
}

async function showReader(id) {
  const book = library.book(id);
  if (!book) { toast('Book not found', { error: true }); return closeReader(true); }
  $('#menu').close?.();
  state.readerBook = book;
  $('#libraryView').hidden = true;
  readerView.hidden = false;
  readerView.classList.remove('chrome-hidden');
  closePanels();
  $('#readerTitle').textContent = book.title;
  $('#readerSub').textContent = book.author || '';
  document.title = `${book.title} · Reads`;
  loadBookmarks(book.id);
  applyDisplay();
  $('#readerLoading').hidden = false;
  $('#readerLoadingText').textContent = 'Opening…';
  $('#pages').replaceChildren();
  try {
    const src = await bookSource(book, { onProgress: (f) => { $('#readerLoadingText').textContent = `Downloading… ${Math.round(f * 100)}%`; } });
    if (state.readerBook !== book) return;
    const p = progress.get(book.id) || {};
    const mode = display.mode;
    const fit = p.fit && p.fit !== 'custom' ? p.fit : (mode === 'paged' ? 'page' : display.fit);
    const coverSrc = state.covers.has(book.id) ? null : src.data ? { data: src.data.slice() } : src;
    const pdf = await reader.open(src, { page: p.page || 1, offset: p.offset || 0, mode, fit, scale: p.fit === 'custom' ? p.scale : undefined });
    if (!pdf || state.readerBook !== book) return;
    $('#pageCount').textContent = pdf.numPages;
    $('#pageSlider').max = pdf.numPages;
    $('#pageSlider').value = reader.current;
    $('#readerLoading').hidden = true;
    saveProgress();
    $('#viewer').focus({ preventScroll: true });
    state.cached = await cachedBookPaths();
    if (coverSrc) renderCover(coverSrc).then((c) => setCover(book.id, c)).catch(() => {});
    loadOutline();
  } catch (e) {
    console.error(e);
    $('#readerLoadingText').textContent = e.message || 'Could not open this PDF.';
  }
}

function closeReader(replace = false) {
  if (state.readerBook) saveProgress();
  reader.close();
  state.readerBook = null;
  readerView.hidden = true;
  $('#libraryView').hidden = false;
  document.title = 'Reads';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (replace && location.hash) history.replaceState(null, '', location.pathname + location.search);
  renderLibrary();
}

$('#backBtn').onclick = () => (history.state?.reader ? history.back() : closeReader(true));
addEventListener('popstate', route);
function route() {
  const m = location.hash.match(/^#\/read\/(.+)$/);
  if (m) showReader(decodeURIComponent(m[1]));
  else if (state.readerBook) closeReader();
}

// Chrome visibility
function toggleChrome(force) {
  const hide = force ?? !readerView.classList.contains('chrome-hidden');
  if (hide && !$('#displayPanel').hidden) return closePanels();
  readerView.classList.toggle('chrome-hidden', hide);
  if (hide) closePanels();
}
let lastScrollTop = 0;
$('#viewer').addEventListener('scroll', () => {
  if (display.mode !== 'scroll') return;
  const st = $('#viewer').scrollTop;
  if (Math.abs(st - lastScrollTop) < 40) return;
  if ($('#displayPanel').hidden && $('#tocPanel').hidden) toggleChrome(st > lastScrollTop);
  lastScrollTop = st;
}, { passive: true });

// Panels
function closePanels() { $('#displayPanel').hidden = true; $('#tocPanel').hidden = true; }
$('#displayBtn').onclick = () => { const h = $('#displayPanel').hidden; closePanels(); $('#displayPanel').hidden = !h; };
$('#tocBtn').onclick = () => { const h = $('#tocPanel').hidden; closePanels(); $('#tocPanel').hidden = !h; if (h) highlightOutline(reader.current, true); };
$$('[data-close]').forEach((b) => (b.onclick = () => ($('#' + b.dataset.close).hidden = true)));

// Navigation controls
$('#prevBtn').onclick = () => reader.goTo(reader.current - 1);
$('#nextBtn').onclick = () => reader.goTo(reader.current + 1);
$('#pageSlider').oninput = (e) => { $('#pageNum').textContent = e.target.value; };
$('#pageSlider').onchange = (e) => reader.goTo(+e.target.value, { instant: true });
$('#pageLabel').onclick = async () => {
  const v = await prompt('Go to page', [{ name: 'p', label: `Page (1–${reader.numPages})`, value: String(reader.current) }], { okText: 'Go' });
  const n = parseInt(v?.p, 10);
  if (n) reader.goTo(n, { instant: true });
};
$('#zoomInBtn').onclick = () => reader.zoomBy(1.15);
$('#zoomOutBtn').onclick = () => reader.zoomBy(1 / 1.15);
$('#zoomLabel').onclick = () => reader.setFit(display.mode === 'paged' ? 'page' : 'width');
$('#fullscreenBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : readerView.requestFullscreen?.().catch(() => {});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => !readerView.hidden && reader.relayout(), 150); });

addEventListener('keydown', (e) => {
  if (readerView.hidden || e.target.closest('input,select,textarea,dialog')) return;
  const k = e.key;
  if (k === 'Escape') { if (!$('#displayPanel').hidden || !$('#tocPanel').hidden) closePanels(); else $('#backBtn').click(); }
  else if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); reader.mode === 'paged' || k !== 'ArrowRight' ? reader.next() : reader.goTo(reader.current + 1); }
  else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); reader.mode === 'paged' || k !== 'ArrowLeft' ? reader.prev() : reader.goTo(reader.current - 1); }
  else if (k === 'ArrowDown' && reader.mode === 'paged') { e.preventDefault(); reader.next(); }
  else if (k === 'ArrowUp' && reader.mode === 'paged') { e.preventDefault(); reader.prev(); }
  else if (k === 'Home') { e.preventDefault(); reader.goTo(1, { instant: true }); }
  else if (k === 'End') { e.preventDefault(); reader.goTo(reader.numPages, { instant: true }); }
  else if (k === '+' || k === '=') { e.preventDefault(); reader.zoomBy(1.15); }
  else if (k === '-') { e.preventDefault(); reader.zoomBy(1 / 1.15); }
  else if (k === '0') reader.setFit(display.mode === 'paged' ? 'page' : 'width');
  else if (k === 'f') $('#fullscreenBtn').click();
  else if (k === 'b') $('#bookmarkBtn').click();
  else if (k === 't') $('#tocBtn').click();
});

// Bookmarks
let bookmarks = new Set();
function loadBookmarks(id) { bookmarks = new Set(prefs.get('bookmarks', {})[id] || []); renderBookmarks(); }
function saveBookmarks() {
  const all = prefs.get('bookmarks', {});
  all[state.readerBook.id] = [...bookmarks].sort((a, b) => a - b);
  prefs.set('bookmarks', all);
  renderBookmarks();
  $('#bookmarkBtn').classList.toggle('on', bookmarks.has(reader.current));
}
$('#bookmarkBtn').onclick = () => {
  const n = reader.current;
  bookmarks.has(n) ? bookmarks.delete(n) : bookmarks.add(n);
  saveBookmarks();
  toast(bookmarks.has(n) ? `Bookmarked page ${n}` : 'Bookmark removed', { ms: 1200 });
};
function renderBookmarks() {
  const list = [...bookmarks].sort((a, b) => a - b);
  $('#bookmarkList').innerHTML = list.length
    ? list.map((n) => `<button class="toc-item" data-page="${n}"><span>Page ${n}</span><span class="pg"></span><span class="del" data-unmark="${n}" title="Remove">✕</span></button>`).join('')
    : '<div class="toc-empty">No bookmarks yet. Tap the bookmark icon (or press B) to save a page.</div>';
}
$('#tocTabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  $$('#tocTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#outlineList').hidden = b.dataset.tab !== 'outline';
  $('#bookmarkList').hidden = b.dataset.tab !== 'bookmarks';
};
$('#tocPanel').addEventListener('click', (e) => {
  const un = e.target.closest('[data-unmark]');
  if (un) { e.stopPropagation(); bookmarks.delete(+un.dataset.unmark); return saveBookmarks(); }
  const item = e.target.closest('[data-page]');
  if (item && item.dataset.page) {
    reader.goTo(+item.dataset.page, { instant: true });
    if (innerWidth < 760) closePanels();
  }
});

let outlineItems = [];
async function loadOutline() {
  $('#outlineList').innerHTML = '<div class="toc-empty">Loading…</div>';
  outlineItems = await reader.outline();
  $('#outlineList').innerHTML = outlineItems.length
    ? outlineItems.map((it) => `<button class="toc-item" data-page="${it.page || ''}" style="padding-left:${10 + it.depth * 16}px"><span>${esc(it.title)}</span><span class="pg">${it.page || ''}</span></button>`).join('')
    : '<div class="toc-empty">This PDF has no table of contents.</div>';
  highlightOutline(reader.current);
}
function highlightOutline(n, scroll = false) {
  let best = null;
  $$('#outlineList .toc-item').forEach((el) => {
    el.classList.remove('current');
    const p = +el.dataset.page;
    if (p && p <= n && (!best || p >= +best.dataset.page)) best = el;
  });
  best?.classList.add('current');
  if (scroll) best?.scrollIntoView({ block: 'center' });
}

addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
addEventListener('pagehide', () => saveProgress());

// =============== Boot ===============
async function boot() {
  applyTheme();
  library.onChange(() => { if (readerView.hidden) renderLibrary(); else updateSyncUi(); });
  await Promise.all([
    loadStoredCovers(),
    cachedBookPaths().then((s) => { state.cached = s; }).catch(() => {}),
  ]);
  await loadLibrary();
  renderLibrary();
  refreshAccount();

  const params = new URLSearchParams(location.search);
  if (params.has('resume') && prefs.get('last')) {
    history.replaceState(null, '', location.pathname);
    openBook(prefs.get('last'));
  } else {
    route();
  }

  if ('serviceWorker' in navigator) {
    // A new version takes over as one unit; reload so HTML and JS always match.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (readerView.hidden && !$('dialog[open]')) location.reload();
      else toast('Reads was updated — the new version loads next time you open it.', { ms: 5000 });
    });
    navigator.serviceWorker.register('sw.js')
      .then((reg) => addEventListener('online', () => reg.update().catch(() => {})))
      .catch((e) => console.warn('SW registration failed', e));
  }
  navigator.storage?.persist?.().catch(() => {});
}
boot();
