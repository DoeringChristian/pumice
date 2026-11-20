import {
  basename,
  type VaultApi,
  type VaultPath,
  type ViewContext,
  type ViewInstance,
  type ViewState,
  type WorkspaceApi,
} from '@pumice/api';
import { createIcon, h } from '@pumice/ui';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import {
  HIGHLIGHT_COLORS,
  mergeBoxes,
  tidyText,
  type AnnotationStore,
  type Box,
  type PdfAnnotation,
} from './annotations';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfViewDeps {
  vault: VaultApi;
  workspace: WorkspaceApi;
  store: AnnotationStore;
  /** The link to a place in a PDF, as it is written in a note. */
  link(path: VaultPath, subpath: string): string;
  lastColor(): string;
  setLastColor(color: string): void;
}

interface Slot {
  index: number;
  el: HTMLElement;
  marks: HTMLElement;
  /** Size in PDF points at scale 1. */
  width: number;
  height: number;
  page?: PDFPageProxy;
  viewport?: PageViewport;
  loading?: Promise<void>;
  canvas?: HTMLCanvasElement;
  task?: RenderTask;
  /** Pixel scale the canvas was drawn at. */
  drawn?: number;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const GAP = 12;
const px = (v: number) => `calc(var(--total-scale-factor) * ${v.toFixed(2)}px)`;

/** `page=3&annotation=abc` (with or without a leading `#`) from a link like `[[a.pdf#page=3]]`. */
export function parseTarget(subpath: unknown): { page?: number; annotation?: string } {
  if (typeof subpath !== 'string') return {};
  const params = new URLSearchParams(subpath.replace(/^#/, ''));
  const page = Number(params.get('page'));
  return {
    ...(Number.isInteger(page) && page > 0 ? { page } : {}),
    ...(params.get('annotation') ? { annotation: params.get('annotation')! } : {}),
  };
}

export function createPdfView(
  view: ViewContext,
  initial: ViewState,
  deps: PdfViewDeps,
): ViewInstance {
  const { vault, store, workspace } = deps;

  const pageLabel = h('span', { class: 'pm-pdf-page-label' });
  const zoomLabel = h('button', { class: 'pm-pdf-zoom-label', title: 'Fit to width' });
  const button = (icon: string, title: string, run: () => void) =>
    h(
      'button',
      { class: 'pm-icon-button', title, 'aria-label': title, onclick: run },
      createIcon(icon, 15),
    );
  const listToggle = button('message-square', 'Show or hide the annotations', () => {
    listOpen = !listOpen;
    renderList();
  });
  const count = h('span', { class: 'pm-pdf-count' });
  listToggle.append(count);
  const bar = h(
    'div',
    { class: 'pm-pdf-bar' },
    pageLabel,
    h('span', { class: 'pm-pdf-spacer' }),
    button('minus', 'Zoom out', () => step(-1)),
    zoomLabel,
    button('plus', 'Zoom in', () => step(1)),
    h('span', { class: 'pm-pdf-sep' }),
    listToggle,
  );
  const pagesEl = h('div', { class: 'pm-pdf-pages' });
  const scroller = h('div', { class: 'pm-pdf-scroll', tabIndex: 0 }, pagesEl);
  const listEl = h('div', { class: 'pm-pdf-list', hidden: true });
  const root = h(
    'div',
    { class: 'pm-pdf' },
    bar,
    h('div', { class: 'pm-pdf-body' }, scroller, listEl),
  );
  view.container.append(root);

  let path: VaultPath | undefined;
  let doc: PDFDocumentProxy | undefined;
  let slots: Slot[] = [];
  let annotations: PdfAnnotation[] = [];
  let zoom: number | 'fit' = 'fit';
  let listOpen: boolean | undefined;
  let generation = 0;
  let floating: HTMLElement | undefined;
  let openId: string | undefined;
  const visible = new Set<Slot>();

  // ---- Layout and zoom ----------------------------------------------------------------------

  const scale = () => {
    if (zoom !== 'fit') return zoom;
    const widest = Math.max(1, ...slots.map((s) => s.width));
    return Math.max(0.25, Math.min(2, (scroller.clientWidth - 2 * GAP - 8) / widest));
  };
  const applyScale = () => {
    const s = scale();
    pagesEl.style.setProperty('--total-scale-factor', String(s));
    pagesEl.style.setProperty('--scale-factor', String(s));
    zoomLabel.textContent =
      zoom === 'fit' ? `Fit (${Math.round(s * 100)}%)` : `${Math.round(s * 100)}%`;
    scheduleDraw();
  };
  const setZoom = (next: number | 'fit') => {
    // Keep the same place of the document in view.
    const anchor = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
    zoom = next;
    applyScale();
    scroller.scrollTop = anchor * scroller.scrollHeight;
  };
  const step = (dir: 1 | -1) => {
    const current = scale();
    const next =
      dir > 0
        ? ZOOMS.find((z) => z > current + 0.01)
        : [...ZOOMS].reverse().find((z) => z < current - 0.01);
    if (next !== undefined) setZoom(next);
  };
  zoomLabel.addEventListener('click', () => setZoom(zoom === 'fit' ? 1 : 'fit'));
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(Math.min(4, Math.max(0.25, scale() * Math.exp(-e.deltaY / 300))));
    },
    { passive: false },
  );
  const resize = new ResizeObserver(() => zoom === 'fit' && slots.length && applyScale());
  resize.observe(scroller);

  const currentPage = () => {
    const line = scroller.scrollTop + scroller.clientHeight / 3;
    let current = 0;
    for (const s of slots) if (s.el.offsetTop <= line) current = s.index;
    return current;
  };
  const updatePageLabel = () => {
    pageLabel.textContent = slots.length ? `Page ${currentPage() + 1} of ${slots.length}` : '';
  };
  scroller.addEventListener('scroll', updatePageLabel, { passive: true });

  // ---- Pages --------------------------------------------------------------------------------

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const slot = slots.find((s) => s.el === e.target);
        if (!slot) continue;
        if (e.isIntersecting) {
          visible.add(slot);
          void show(slot);
        } else visible.delete(slot);
      }
      evict();
    },
    { root: scroller, rootMargin: '600px 0px' },
  );

  const sizeSlot = (slot: Slot) => {
    slot.el.style.width = px(slot.width);
    slot.el.style.height = px(slot.height);
  };

  /** Loads a page, builds its text (once) and draws it. */
  const show = async (slot: Slot) => {
    const gen = generation;
    slot.loading ??= (async () => {
      const page = await doc!.getPage(slot.index + 1);
      if (gen !== generation) return;
      const viewport = page.getViewport({ scale: 1 });
      slot.page = page;
      slot.viewport = viewport;
      if (viewport.width !== slot.width || viewport.height !== slot.height) {
        slot.width = viewport.width;
        slot.height = viewport.height;
        sizeSlot(slot);
      }
      const textLayer = h('div', { class: 'textLayer pm-pdf-text' });
      slot.el.append(textLayer);
      await new pdfjs.TextLayer({
        textContentSource: await page.getTextContent(),
        container: textLayer,
        viewport,
      }).render();
      drawMarks(slot);
    })();
    await slot.loading.catch(() => undefined);
    if (gen === generation && visible.has(slot)) void draw(slot);
  };

  const draw = async (slot: Slot) => {
    if (!slot.page) return;
    const s = scale();
    // Sharp on high-density screens, within what a canvas can hold.
    let ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    const limit = 24_000_000;
    const area = slot.width * slot.height * s * s * ratio * ratio;
    if (area > limit) ratio *= Math.sqrt(limit / area);
    const target = s * ratio;
    if (slot.drawn && Math.abs(slot.drawn - target) < 0.001) return;
    slot.task?.cancel();
    const viewport = slot.page.getViewport({ scale: target });
    const canvas = h('canvas', { class: 'pm-pdf-canvas' });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = slot.page.render({ canvas, viewport });
    slot.task = task;
    try {
      await task.promise;
    } catch {
      return; // Replaced by a newer drawing, or the view closed.
    }
    if (slot.task !== task) return;
    slot.canvas?.remove();
    slot.canvas = canvas;
    slot.drawn = target;
    slot.el.prepend(canvas);
  };

  let drawTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDraw = () => {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(() => visible.forEach((s) => void draw(s)), 120);
  };

  /** Frees the drawings of pages far from the ones in view. */
  const evict = () => {
    const drawn = slots.filter((s) => s.canvas && !visible.has(s));
    if (drawn.length <= 8) return;
    const here = currentPage();
    drawn
      .sort((a, b) => Math.abs(b.index - here) - Math.abs(a.index - here))
      .slice(0, drawn.length - 8)
      .forEach((s) => {
        s.canvas?.remove();
        s.canvas = undefined;
        s.drawn = undefined;
      });
  };

  // ---- Annotations --------------------------------------------------------------------------

  /** An annotation's boxes on screen, at scale 1 from the page's top-left corner. */
  const boxesOf = (slot: Slot, a: PdfAnnotation): Box[] =>
    a.rects.map((r) => {
      const [ax, ay] = slot.viewport!.convertToViewportPoint(r.x1, r.y1) as [number, number];
      const [bx, by] = slot.viewport!.convertToViewportPoint(r.x2, r.y2) as [number, number];
      return {
        left: Math.min(ax, bx),
        top: Math.min(ay, by),
        right: Math.max(ax, bx),
        bottom: Math.max(ay, by),
      };
    });

  const drawMarks = (slot: Slot) => {
    if (!slot.viewport) return;
    slot.marks.replaceChildren();
    for (const a of annotations) {
      if (a.page !== slot.index) continue;
      const boxes = boxesOf(slot, a);
      boxes.forEach((b, i) => {
        const mark = h('div', { class: 'pm-pdf-mark', 'data-id': a.id });
        mark.classList.toggle('is-open', a.id === openId);
        mark.style.left = px(b.left);
        mark.style.top = px(b.top);
        mark.style.width = px(b.right - b.left);
        mark.style.height = px(b.bottom - b.top);
        mark.style.backgroundColor = a.color;
        slot.marks.append(mark);
        if (a.note && i === boxes.length - 1) {
          const flag = h('div', { class: 'pm-pdf-note-flag', title: a.note });
          flag.style.left = px(b.right);
          flag.style.top = px(b.top);
          flag.style.backgroundColor = a.color;
          flag.append(createIcon('message-square', 10));
          slot.marks.append(flag);
        }
      });
    }
  };

  const refresh = async () => {
    if (!path) return;
    const gen = generation;
    const next = await store.list(path);
    if (gen !== generation) return;
    annotations = next;
    slots.forEach(drawMarks);
    renderList();
  };

  const closeFloating = () => {
    floating?.remove();
    floating = undefined;
    if (openId) {
      openId = undefined;
      slots.forEach(drawMarks);
      renderList();
    }
  };

  /** Places a floating box under a point of the page column (in screen coordinates). */
  const float = (el: HTMLElement, x: number, y: number) => {
    floating?.remove();
    floating = el;
    const origin = pagesEl.getBoundingClientRect();
    pagesEl.append(el);
    const left = Math.max(4, Math.min(x - origin.left, pagesEl.clientWidth - el.offsetWidth - 4));
    el.style.left = `${left}px`;
    el.style.top = `${y - origin.top + 6}px`;
  };

  const swatches = (current: string | undefined, pick: (color: string) => void) =>
    HIGHLIGHT_COLORS.map((c) => {
      const b = h('button', {
        class: 'pm-pdf-swatch',
        type: 'button',
        title: `Highlight ${c.name.toLowerCase()}`,
        'aria-label': `Highlight ${c.name.toLowerCase()}`,
      });
      b.style.backgroundColor = c.value;
      b.classList.toggle('is-current', c.value === current);
      // mousedown: keep the text selection until the highlight is made.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => pick(c.value));
      return b;
    });

  /** The current text selection as highlights, one per page it touches. */
  const selectionParts = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    if (!pagesEl.contains(range.commonAncestorContainer)) return [];
    const s = scale();
    const parts: Array<{ slot: Slot; boxes: Box[]; text: string; end: DOMRect }> = [];
    for (const slot of slots) {
      const layer = slot.el.querySelector('.pm-pdf-text');
      if (!layer || !slot.viewport || !range.intersectsNode(layer)) continue;
      const origin = slot.el.getBoundingClientRect();
      const boxes: Box[] = [];
      let text = '';
      let end: DOMRect | undefined;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!range.intersectsNode(node)) continue;
        const part = document.createRange();
        part.selectNodeContents(node);
        if (node === range.startContainer) part.setStart(node, range.startOffset);
        if (node === range.endContainer) part.setEnd(node, range.endOffset);
        const piece = part.toString();
        if (!piece) continue;
        // Text runs follow each other without the spaces and breaks the page shows.
        const isBreak = node.parentElement?.previousElementSibling?.tagName === 'BR';
        text += (text && (isBreak || !/\s$/.test(text)) && !/^\s/.test(piece) ? ' ' : '') + piece;
        for (const r of part.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          end = r;
          boxes.push({
            left: (r.left - origin.left) / s,
            top: (r.top - origin.top) / s,
            right: (r.right - origin.left) / s,
            bottom: (r.bottom - origin.top) / s,
          });
        }
      }
      const merged = mergeBoxes(boxes);
      if (merged.length && end) parts.push({ slot, boxes: merged, text: tidyText(text), end });
    }
    return parts;
  };

  const highlightSelection = async (color: string, withNote: boolean) => {
    const parts = selectionParts();
    if (!parts.length || !path) return;
    deps.setLastColor(color);
    let last: PdfAnnotation | undefined;
    for (const part of parts) {
      last = await store.add(path, {
        page: part.slot.index,
        color,
        text: part.text,
        rects: part.boxes.map((b) => {
          const [x1, y1] = part.slot.viewport!.convertToPdfPoint(b.left, b.top) as [number, number];
          const [x2, y2] = part.slot.viewport!.convertToPdfPoint(b.right, b.bottom) as [
            number,
            number,
          ];
          return { x1, y1, x2, y2 };
        }),
      });
    }
    document.getSelection()?.removeAllRanges();
    closeFloating();
    await refresh();
    if (withNote && last) openAnnotation(last.id, true);
  };

  const showSelectionBar = () => {
    const parts = selectionParts();
    if (!parts.length) {
      if (floating?.classList.contains('pm-pdf-selbar')) closeFloating();
      return;
    }
    closeFloating();
    const noteButton = h(
      'button',
      { class: 'pm-pdf-tool', type: 'button', title: 'Highlight and add a note' },
      createIcon('message-square-plus', 15),
    );
    noteButton.addEventListener('mousedown', (e) => e.preventDefault());
    noteButton.addEventListener('click', () => void highlightSelection(deps.lastColor(), true));
    const copy = h(
      'button',
      { class: 'pm-pdf-tool', type: 'button', title: 'Copy as a quote with a link to this page' },
      createIcon('quote', 15),
    );
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', () => {
      const first = parts[0]!;
      void copyQuote(parts.map((p) => p.text).join(' '), `page=${first.slot.index + 1}`);
      closeFloating();
    });
    const barEl = h(
      'div',
      { class: 'pm-pdf-floating pm-pdf-selbar' },
      ...swatches(undefined, (c) => void highlightSelection(c, false)),
      h('span', { class: 'pm-pdf-sep' }),
      noteButton,
      copy,
    );
    const end = parts[parts.length - 1]!.end;
    float(barEl, end.right - 40, end.bottom);
  };

  const copyQuote = async (text: string, subpath: string) => {
    if (!path) return;
    const quote = `> ${text}\n> — ${deps.link(path, subpath)}\n`;
    try {
      await navigator.clipboard.writeText(quote);
      workspace.notify('Quote copied. Paste it into a note.', { timeout: 2500 });
    } catch {
      workspace.notify('Could not copy to the clipboard.', { kind: 'warning' });
    }
  };

  const reveal = (a: PdfAnnotation) => {
    const slot = slots[a.page];
    if (!slot) return;
    const s = scale();
    const top = slot.viewport
      ? Math.min(...boxesOf(slot, a).map((b) => b.top)) * s
      : // Not loaded yet: PDF units run upwards from the bottom of the page.
        (slot.height - Math.max(...a.rects.map((r) => Math.max(r.y1, r.y2)))) * s;
    scroller.scrollTop = slot.el.offsetTop + top - scroller.clientHeight / 3;
  };

  const openAnnotation = (id: string, focusNote = false) => {
    const a = annotations.find((x) => x.id === id);
    const slot = a && slots[a.page];
    if (!a || !slot || !path) return;
    const file = path;
    closeFloating();
    openId = id;
    slots.forEach(drawMarks);
    renderList();
    const note = h('textarea', {
      class: 'pm-pdf-note-input',
      rows: 3,
      placeholder: 'Add a note…',
      'aria-label': 'Note',
    });
    note.value = a.note ?? '';
    const save = () => {
      if (note.value !== (a.note ?? '')) void store.update(file, id, { note: note.value });
    };
    note.addEventListener('blur', save);
    note.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        save();
        closeFloating();
      }
    });
    const tool = (icon: string, title: string, run: () => void, cls = '') =>
      h(
        'button',
        { class: `pm-pdf-tool ${cls}`, type: 'button', title, 'aria-label': title, onclick: run },
        createIcon(icon, 15),
      );
    const box = h(
      'div',
      { class: 'pm-pdf-floating pm-pdf-popover' },
      h(
        'div',
        { class: 'pm-pdf-popover-row' },
        ...swatches(a.color, (color) => {
          deps.setLastColor(color);
          save();
          // Reopen with the new color marked.
          void store
            .update(file, id, { color })
            .then(refresh)
            .then(() => openAnnotation(id));
        }),
        h('span', { class: 'pm-pdf-spacer' }),
        tool(
          'quote',
          'Copy as a quote with a link to this highlight',
          () => void copyQuote(a.text, `page=${a.page + 1}&annotation=${a.id}`),
        ),
        tool(
          'trash',
          'Delete this highlight',
          () => {
            closeFloating();
            void store.remove(file, id);
          },
          'is-danger',
        ),
      ),
      note,
    );
    const place = () => {
      const marks = slot.marks.querySelectorAll<HTMLElement>(`.pm-pdf-mark[data-id="${id}"]`);
      const last = marks[marks.length - 1]?.getBoundingClientRect();
      if (last) float(box, last.left, last.bottom);
    };
    if (slot.viewport) place();
    else void show(slot).then(place);
    if (focusNote) requestAnimationFrame(() => note.focus());
  };

  // Text selection → the highlight bar; a click on a highlight → its note.
  let pointerDown = false;
  pagesEl.addEventListener('mousedown', (e) => {
    if (floating?.contains(e.target as Node)) return;
    pointerDown = true;
    if (floating?.classList.contains('pm-pdf-selbar')) closeFloating();
  });
  const onMouseUp = (e: MouseEvent) => {
    if (!pointerDown) return;
    pointerDown = false;
    if (floating?.contains(e.target as Node)) return;
    // After the browser has settled the selection.
    setTimeout(() => {
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && pagesEl.contains(sel.anchorNode)) return showSelectionBar();
      const slot = slots.find((s) => s.el.contains(e.target as Node));
      if (!slot?.viewport) return closeFloating();
      const origin = slot.el.getBoundingClientRect();
      const s = scale();
      const x = (e.clientX - origin.left) / s;
      const y = (e.clientY - origin.top) / s;
      const hit = annotations.find(
        (a) =>
          a.page === slot.index &&
          boxesOf(slot, a).some(
            (b) => x >= b.left - 1 && x <= b.right + 12 && y >= b.top - 1 && y <= b.bottom + 1,
          ),
      );
      if (hit) openAnnotation(hit.id);
      else closeFloating();
    });
  };
  window.addEventListener('mouseup', onMouseUp);
  // Selections made with the keyboard (Shift+arrows) or by touch.
  let selTimer: ReturnType<typeof setTimeout> | undefined;
  const onSelectionChange = () => {
    if (pointerDown || floating?.classList.contains('pm-pdf-popover')) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(showSelectionBar, 250);
  };
  document.addEventListener('selectionchange', onSelectionChange);
  scroller.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFloating();
  });

  // ---- The list of annotations --------------------------------------------------------------

  const renderList = () => {
    count.textContent = annotations.length ? String(annotations.length) : '';
    const open = listOpen ?? annotations.length > 0;
    listEl.hidden = !open;
    listToggle.classList.toggle('is-active', open);
    if (!open) return;
    if (!annotations.length) {
      listEl.replaceChildren(
        h(
          'div',
          { class: 'pm-pdf-list-empty' },
          'No highlights yet. Select text on a page and pick a color.',
        ),
      );
      return;
    }
    listEl.replaceChildren(
      ...annotations.map((a) => {
        const dot = h('span', { class: 'pm-pdf-dot' });
        dot.style.backgroundColor = a.color;
        const item = h(
          'button',
          { class: 'pm-pdf-list-item', type: 'button' },
          h('div', { class: 'pm-pdf-list-head' }, dot, `Page ${a.page + 1}`),
          h('div', { class: 'pm-pdf-list-text' }, a.text || '(no text)'),
          a.note ? h('div', { class: 'pm-pdf-list-note' }, a.note) : null,
        );
        item.classList.toggle('is-open', a.id === openId);
        item.addEventListener('click', () => {
          reveal(a);
          // After the scroll, so the box lands next to the highlight.
          requestAnimationFrame(() => openAnnotation(a.id));
        });
        return item;
      }),
    );
  };

  // ---- Loading ------------------------------------------------------------------------------

  const goTo = (target: { page?: number; annotation?: string }) => {
    const a = target.annotation && annotations.find((x) => x.id === target.annotation);
    if (a) {
      reveal(a);
      requestAnimationFrame(() => openAnnotation(a.id));
    } else if (target.page && slots[target.page - 1]) {
      scroller.scrollTop = slots[target.page - 1]!.el.offsetTop - GAP;
    }
  };

  const unload = () => {
    generation++;
    closeFloating();
    observer.disconnect();
    visible.clear();
    slots.forEach((s) => s.task?.cancel());
    slots = [];
    annotations = [];
    pagesEl.replaceChildren();
    void doc?.loadingTask.destroy();
    doc = undefined;
  };

  const message = (text: string) =>
    pagesEl.replaceChildren(h('div', { class: 'pm-pdf-message' }, text));

  const sha256 = async (bytes: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const load = async (next: VaultPath | undefined, state: ViewState) => {
    unload();
    const gen = generation;
    path = next;
    listOpen = undefined;
    zoom = typeof state.zoom === 'number' ? state.zoom : 'fit';
    updatePageLabel();
    if (!path) return;
    view.setFile(path);
    view.setTitle(basename(path));
    message('Opening…');
    let loaded: PDFDocumentProxy;
    try {
      const bytes = await vault.readBinary(path);
      if (gen !== generation) return;
      // Highlights made in Obsidian's PDF Annotator, for a PDF that has none here yet.
      if (await store.isNew(path)) {
        const found = await store.readObsidianAnnotations(await sha256(bytes));
        if (found.length) await store.import(path, found);
      }
      // The reader takes the bytes over.
      loaded = await pdfjs.getDocument({ data: bytes }).promise;
    } catch (e) {
      if (gen !== generation) return;
      const reason = e instanceof Error ? e.message : String(e);
      message(
        /password/i.test(reason)
          ? 'This PDF is protected by a password and can’t be opened here.'
          : `Could not open this PDF: ${reason}`,
      );
      return;
    }
    if (gen !== generation) {
      void loaded.loadingTask.destroy();
      return;
    }
    doc = loaded;
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    if (gen !== generation) return;
    pagesEl.replaceChildren();
    slots = Array.from({ length: doc.numPages }, (_, index) => {
      const marks = h('div', { class: 'pm-pdf-marks' });
      const el = h('div', { class: 'pm-pdf-page', 'data-page': String(index + 1) }, marks);
      const slot: Slot = { index, el, marks, width: first.width, height: first.height };
      sizeSlot(slot);
      pagesEl.append(el);
      return slot;
    });
    applyScale();
    await refresh();
    if (gen !== generation) return;
    slots.forEach((s) => observer.observe(s.el));
    const target = parseTarget(state.subpath);
    if (target.page || target.annotation) goTo(target);
    else if (typeof state.page === 'number') goTo({ page: state.page });
    updatePageLabel();
  };

  const subs = [
    store.onDidChange((changed) => {
      if (changed === path) void refresh();
    }),
    vault.onDidChange((changes) => {
      for (const c of changes) {
        if (c.type === 'rename' && c.oldPath === path) {
          path = c.entry.path;
          view.setFile(path);
          view.setTitle(basename(path));
          // The annotations file moves along; read it from its new place.
          setTimeout(() => void refresh(), 300);
        }
      }
    }),
  ];

  void load(typeof initial.path === 'string' ? initial.path : undefined, initial);

  return {
    getState: (): ViewState =>
      path ? { path, page: currentPage() + 1, ...(zoom === 'fit' ? {} : { zoom }) } : {},
    setState: async (state) => {
      const next = typeof state.path === 'string' ? state.path : undefined;
      // A link into the PDF that is already open only moves to its target.
      if (next === path && doc) {
        const target = parseTarget(state.subpath);
        goTo(target.page || target.annotation ? target : { page: Number(state.page) || undefined });
        return;
      }
      await load(next, state);
    },
    focus: () => scroller.focus(),
    dispose() {
      unload();
      subs.forEach((s) => s.dispose());
      resize.disconnect();
      clearTimeout(drawTimer);
      clearTimeout(selTimer);
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    },
  };
}
