// PDF reader: lazy page rendering, scroll + page-flip layouts, zoom & pinch.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;

const PAD_TOP = 64;      // matches .pages padding-top (minus safe area)
const PAD_BOTTOM = 70;
const MAX_FIT_WIDTH = 980;
const MAX_CANVAS_PIXELS = 12e6;
const KEEP_RANGE = 4;    // rendered pages kept on each side of the current page

export function openDocument(src) {
  return pdfjsLib.getDocument({
    ...src,
    cMapUrl: VENDOR + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
}

export async function renderCover(src, width = 320) {
  const pdf = await openDocument({ ...src, disableAutoFetch: true, disableStream: true });
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  } finally {
    pdf.destroy();
  }
}

export class Reader {
  constructor({ root, viewer, pages, onPage, onTap }) {
    Object.assign(this, { root, viewer, pages, onPage, onTap });
    this.pdf = null;
    this.slots = [];
    this.sizes = [];
    this.scale = 1;
    this.fit = 'width';
    this.mode = 'scroll';
    this.current = 1;
    this.rendering = new Map();
    this.queue = new Set();
    this.raf = 0;
    this._bind();
  }

  // ---------- lifecycle ----------
  async open(src, { page = 1, offset = 0, mode = 'scroll', fit = 'width', scale } = {}) {
    this.close();
    const token = (this.token = Symbol());
    const pdf = await openDocument(src);
    if (token !== this.token) { pdf.destroy(); return null; }
    this.pdf = pdf;
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.base = { w: vp.width, h: vp.height };
    this.sizes = Array.from({ length: pdf.numPages }, () => ({ ...this.base }));
    this.mode = mode;
    this.fit = scale ? 'custom' : fit;
    this.scale = scale || this._fitScale(fit);
    this.root.classList.toggle('paged', mode === 'paged');
    this._build();
    this.goTo(Math.min(Math.max(1, page), pdf.numPages), { offset, instant: true });
    this._observe();
    return pdf;
  }

  close() {
    this.token = null;
    this.io?.disconnect();
    this.rendering.forEach((t) => t.cancel());
    this.rendering.clear();
    this.queue.clear();
    this.pages.replaceChildren();
    this.slots = [];
    this.current = 1;
    this._announced = false;
    this.pdf?.destroy();
    this.pdf = null;
  }

  get numPages() { return this.pdf?.numPages || 0; }

  // ---------- layout ----------
  _viewerBox() {
    const r = this.viewer.getBoundingClientRect();
    const cs = getComputedStyle(this.pages);
    const top = parseFloat(cs.paddingTop) || PAD_TOP;
    const bottom = parseFloat(cs.paddingBottom) || PAD_BOTTOM;
    return { w: r.width, h: r.height, top, bottom };
  }

  _fitScale(fit) {
    if (!this.base) return 1;
    const { w, h } = this._viewerBox();
    const pagedPad = this.mode === 'paged' ? 124 : 0;
    const byWidth = Math.min(w - 24, MAX_FIT_WIDTH) / this.base.w;
    const byPage = Math.min((w - 24) / this.base.w, (h - (this.mode === 'paged' ? pagedPad : PAD_TOP + PAD_BOTTOM) - 10) / this.base.h);
    return fit === 'page' ? byPage : byWidth;
  }

  _build() {
    const frag = document.createDocumentFragment();
    this.slots = this.sizes.map((s, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.n = i + 1;
      el.innerHTML = `<span class="pnum">${i + 1}</span>`;
      slot.append(el);
      frag.append(slot);
      return { slot, el, canvas: null, renderedScale: 0 };
    });
    this.pages.replaceChildren(frag);
    this._applySizes();
  }

  _applySizes() {
    this.slots.forEach((s, i) => {
      s.el.style.width = `${Math.floor(this.sizes[i].w * this.scale)}px`;
      s.el.style.height = `${Math.floor(this.sizes[i].h * this.scale)}px`;
    });
  }

  setMode(mode) {
    if (mode === this.mode || !this.pdf) return;
    const page = this.current;
    this.mode = mode;
    this.root.classList.toggle('paged', mode === 'paged');
    if (this.fit !== 'custom') this.scale = this._fitScale(this.fit);
    this._applySizes();
    this._observe();
    this.goTo(page, { instant: true });
    this._invalidate();
  }

  setFit(fit) {
    if (!this.pdf) return;
    this.fit = fit;
    this.setScale(this._fitScale(fit), { keepFit: true });
  }

  setScale(scale, { keepFit = false, focus } = {}) {
    if (!this.pdf) return;
    scale = Math.min(Math.max(scale, 0.25), 6);
    if (!keepFit) this.fit = 'custom';
    const v = this.viewer;
    const fx = focus ? focus.x : v.clientWidth / 2;
    const fy = focus ? focus.y : v.clientHeight / 2;
    const ratio = scale / this.scale;
    const anchor = this._anchor();
    const cx = v.scrollLeft + fx, cy = v.scrollTop + fy;
    this.scale = scale;
    this._applySizes();
    if (this.mode === 'scroll' && focus) {
      v.scrollLeft = cx * ratio - fx;
      v.scrollTop = cy * ratio - fy;
    } else if (this.mode === 'scroll') {
      this._restoreAnchor(anchor);
      v.scrollLeft = Math.max(0, (v.scrollWidth - v.clientWidth) / 2);
    } else {
      this.goTo(this.current, { instant: true });
    }
    this._invalidate();
    this.onPage?.(this.current, { scale: this.scale, fit: this.fit });
  }

  zoomBy(f, focus) { this.setScale(this.scale * f, { focus }); }

  relayout() {
    if (!this.pdf) return;
    if (this.fit !== 'custom') this.setScale(this._fitScale(this.fit), { keepFit: true });
    else this.goTo(this.current, { instant: true });
  }

  // ---------- navigation ----------
  goTo(n, { offset = 0, instant = false } = {}) {
    if (!this.pdf) return;
    n = Math.min(Math.max(1, n), this.numPages);
    const s = this.slots[n - 1];
    if (this.mode === 'paged') {
      this.viewer.scrollTo({ left: (n - 1) * this.viewer.clientWidth, top: 0, behavior: instant ? 'instant' : 'smooth' });
    } else {
      const top = s.el.offsetTop - 12 + offset * s.el.offsetHeight;
      this.viewer.scrollTo({ top, behavior: instant ? 'instant' : 'auto' });
    }
    this._setCurrent(n);
  }

  next() { this.mode === 'paged' ? this.goTo(this.current + 1) : this._scrollScreen(1); }
  prev() { this.mode === 'paged' ? this.goTo(this.current - 1) : this._scrollScreen(-1); }

  _scrollScreen(dir) {
    this.viewer.scrollBy({ top: dir * (this.viewer.clientHeight - PAD_TOP - 40), behavior: 'smooth' });
  }

  // Position within the current page (0..1), used to resume precisely.
  _anchor() {
    const s = this.slots[this.current - 1];
    if (!s || this.mode === 'paged') return { page: this.current, offset: 0 };
    const off = (this.viewer.scrollTop + 12 - s.el.offsetTop) / Math.max(1, s.el.offsetHeight);
    return { page: this.current, offset: Math.min(Math.max(off, 0), 0.99) };
  }

  _restoreAnchor(a) { this.goTo(a.page, { offset: a.offset, instant: true }); }

  position() { return this._anchor(); }

  _detectCurrent() {
    if (!this.slots.length) return;
    let n;
    if (this.mode === 'paged') {
      n = Math.round(this.viewer.scrollLeft / Math.max(1, this.viewer.clientWidth)) + 1;
    } else {
      const probe = this.viewer.scrollTop + this.viewer.clientHeight * 0.35;
      let lo = 0, hi = this.slots.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.slots[mid].el.offsetTop <= probe) lo = mid; else hi = mid - 1;
      }
      n = lo + 1;
    }
    this._setCurrent(Math.min(Math.max(1, n), this.numPages));
  }

  _setCurrent(n) {
    if (n === this.current && this._announced) return;
    this.current = n;
    this._announced = true;
    this.onPage?.(n, { scale: this.scale, fit: this.fit });
    this._prune();
  }

  // ---------- rendering ----------
  _observe() {
    this.io?.disconnect();
    const margin = this.mode === 'paged' ? '0px 120% 0px 120%' : '120% 0px 120% 0px';
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = +e.target.dataset.n - 1;
        if (e.isIntersecting) this._enqueue(i); else this.queue.delete(i);
      }
      this._pump();
    }, { root: this.viewer, rootMargin: margin });
    this.slots.forEach((s) => this.io.observe(s.el));
  }

  _invalidate() {
    // Keep old canvases visible (stretched) until crisp re-render lands.
    this.slots.forEach((s, i) => {
      if (s.canvas && Math.abs(s.renderedScale - this.scale) > 0.001 && this._near(i)) this._enqueue(i);
    });
    this._pump();
  }

  _near(i) { return Math.abs(i + 1 - this.current) <= KEEP_RANGE; }

  _enqueue(i) {
    const s = this.slots[i];
    if (!s || this.rendering.has(i)) return;
    if (s.canvas && Math.abs(s.renderedScale - this.scale) < 0.001) return;
    this.queue.add(i);
  }

  _pump() {
    while (this.rendering.size < 2 && this.queue.size) {
      // Render closest-to-current first.
      const i = [...this.queue].sort((a, b) => Math.abs(a + 1 - this.current) - Math.abs(b + 1 - this.current))[0];
      this.queue.delete(i);
      this._render(i);
    }
  }

  async _render(i) {
    const s = this.slots[i];
    const pdf = this.pdf;
    const scale = this.scale;
    const job = { cancelled: false, task: null, cancel() { this.cancelled = true; this.task?.cancel(); } };
    this.rendering.set(i, job);
    try {
      const page = await pdf.getPage(i + 1);
      if (job.cancelled || pdf !== this.pdf) return;
      const vp1 = page.getViewport({ scale: 1 });
      if (Math.abs(vp1.width - this.sizes[i].w) > 0.5 || Math.abs(vp1.height - this.sizes[i].h) > 0.5) {
        const anchor = this._anchor();
        this.sizes[i] = { w: vp1.width, h: vp1.height };
        s.el.style.width = `${Math.floor(vp1.width * this.scale)}px`;
        s.el.style.height = `${Math.floor(vp1.height * this.scale)}px`;
        if (i + 1 < this.current && this.mode === 'scroll') this._restoreAnchor(anchor);
      }
      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      const css = page.getViewport({ scale });
      if (css.width * css.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (css.width * css.height));
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      job.task = page.render({ canvasContext: ctx, viewport: vp });
      await job.task.promise;
      if (job.cancelled || pdf !== this.pdf) return;
      s.el.querySelector('canvas')?.remove();
      s.el.querySelector('.pnum')?.remove();
      s.el.append(canvas);
      s.canvas = canvas;
      s.renderedScale = scale;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn('render failed', i + 1, e);
    } finally {
      if (this.rendering.get(i) === job) this.rendering.delete(i);
      if (pdf === this.pdf) {
        if (Math.abs(scale - this.scale) > 0.001 && this._near(i)) this._enqueue(i);
        this._pump();
      }
    }
  }

  // Free canvases far from the reading position (mobile GPU memory is tight).
  _prune() {
    this.slots.forEach((s, i) => {
      if (s.canvas && Math.abs(i + 1 - this.current) > KEEP_RANGE * 2) {
        s.canvas.width = s.canvas.height = 0;
        s.canvas.remove();
        s.canvas = null;
        s.renderedScale = 0;
        s.el.innerHTML = `<span class="pnum">${i + 1}</span>`;
      }
    });
  }

  // ---------- input ----------
  _bind() {
    const v = this.viewer;
    v.addEventListener('scroll', () => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this._detectCurrent(); });
    }, { passive: true });

    // Ctrl/⌘ + wheel and trackpad pinch → zoom around the cursor.
    let wheelScale = 1, wheelTimer, wheelFocus;
    v.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = v.getBoundingClientRect();
      wheelFocus = { x: e.clientX - r.left, y: e.clientY - r.top };
      wheelScale *= Math.exp(-e.deltaY * 0.01);
      this._preview(wheelScale, wheelFocus);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        this._endPreview();
        this.setScale(this.scale * wheelScale, { focus: wheelFocus });
        wheelScale = 1;
      }, 160);
    }, { passive: false });

    // Touch: pinch zoom + tap.
    let pinch = null, tap = null;
    v.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        const r = v.getBoundingClientRect();
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), f: 1,
          focus: { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top } };
        tap = null;
      } else if (e.touches.length === 1) {
        tap = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      }
    }, { passive: true });
    v.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        pinch.f = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d;
        this._preview(pinch.f, pinch.focus);
      } else if (tap) {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > 10) tap = null;
      }
    }, { passive: false });
    v.addEventListener('touchend', (e) => {
      if (pinch && e.touches.length < 2) {
        const { f, focus } = pinch;
        pinch = null;
        this._endPreview();
        if (Math.abs(f - 1) > 0.02) this.setScale(this.scale * f, { focus });
      }
    });
    // Block Safari page-level pinch so ours handles it.
    ['gesturestart', 'gesturechange'].forEach((t) => v.addEventListener(t, (e) => e.preventDefault()));

    v.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      const r = v.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      if (this.mode === 'paged' && this.fit !== 'custom') {
        if (x < 0.25) return this.prev();
        if (x > 0.75) return this.next();
      }
      this.onTap?.();
    });
  }

  _preview(f, focus) {
    const v = this.viewer;
    this.pages.style.transformOrigin = `${v.scrollLeft + focus.x}px ${v.scrollTop + focus.y}px`;
    this.pages.style.transform = `scale(${f})`;
  }

  _endPreview() {
    this.pages.style.transform = '';
    this.pages.style.transformOrigin = '';
  }

  // ---------- outline ----------
  async outline() {
    if (!this.pdf) return [];
    const items = (await this.pdf.getOutline().catch(() => null)) || [];
    const pdf = this.pdf;
    const resolve = async (dest) => {
      try {
        const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        if (!d) return null;
        return typeof d[0] === 'number' ? d[0] + 1 : (await pdf.getPageIndex(d[0])) + 1;
      } catch { return null; }
    };
    const walk = async (list, depth) => {
      const out = [];
      for (const it of list) {
        out.push({ title: it.title, depth, page: it.dest ? await resolve(it.dest) : null });
        if (it.items?.length && depth < 3) out.push(...(await walk(it.items, depth + 1)));
      }
      return out;
    };
    return walk(items, 0);
  }
}
