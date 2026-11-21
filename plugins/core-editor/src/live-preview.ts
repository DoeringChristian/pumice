import {
  attachMenuButton,
  attachResizeHandle,
  blockSizeEdit,
  embedSizeEdit,
  type Size,
} from './resize';
import { syntaxTree } from '@codemirror/language';
import type { TreeCursor } from '@lezer/common';
import { Facet, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import {
  calloutTypeAt,
  previewBlockOwners,
  revealChanged,
  revealedLines,
  revealTracking,
  type MarkdownSyntaxApi,
  type ReaderApi,
  type VaultPath,
  parseEmbedSize,
  setEmbedSize,
  embedCaption,
  figureLabel,
  figureReference,
  isFigureTarget,
  numberItems,
  type FigureKind,
  type NumberedItem,
} from '@pumice/api';
import { calloutStyle, createIcon } from '@pumice/ui';

/** Services the preview widgets use; provided per editor. */
export interface PreviewDeps {
  syntax: MarkdownSyntaxApi;
  reader?: ReaderApi;
  sourcePath(): VaultPath | undefined;
  /** Shows the menu of an embedded picture, video or frame (right-click). */
  embedMenu?(view: EditorView, host: HTMLElement, at: { x: number; y: number }): void;
  /** Shows the menu of a rendered block (a frame block): edit its source, remove it. */
  blockMenu?(
    view: EditorView,
    block: { from: number; to: number },
    at: { x: number; y: number },
  ): void;
}

export const previewDeps = Facet.define<PreviewDeps, PreviewDeps | undefined>({
  combine: (values) => values[0],
});

/** Markers hidden in live preview unless the cursor is on their line. */
const HIDDEN_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HighlightMark']);

const MARK_CLASSES: Record<string, string> = {
  Emphasis: 'cm-pm-em',
  StrongEmphasis: 'cm-pm-strong',
  Strikethrough: 'cm-pm-strike',
  InlineCode: 'cm-pm-code',
  Highlight: 'cm-pm-highlight',
  Tag: 'cm-pm-tag',
  Comment: 'cm-pm-comment',
  BlockId: 'cm-pm-block-id',
  FootnoteReference: 'cm-pm-footnote',
};

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-pm-checkbox';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Completed task' : 'Open task');
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' },
      });
    });
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'cm-pm-bullet';
    dot.textContent = '•';
    return dot;
  }

  override eq(): boolean {
    return true;
  }
}

class RuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement('hr');
    hr.className = 'cm-pm-hr';
    return hr;
  }

  override eq(): boolean {
    return true;
  }
}

class CalloutIconWidget extends WidgetType {
  constructor(readonly type: string) {
    super();
  }

  override eq(other: CalloutIconWidget): boolean {
    return other.type === this.type;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-pm-callout-icon';
    span.append(createIcon(calloutStyle(this.type).icon, 16));
    const label = document.createElement('span');
    label.className = 'cm-pm-callout-label';
    label.textContent = this.type.charAt(0).toUpperCase() + this.type.slice(1);
    span.append(label);
    return span;
  }
}

/**
 * Where in the TeX source a click on a rendered formula points: the symbol under the pointer
 * (each carries its place), or the one nearest to it.
 */
function texOffsetAt(root: HTMLElement, event: MouseEvent): number | undefined {
  const offset = (el: Element) => Number((el as HTMLElement).dataset.p);
  const hit = (event.target as Element).closest?.('[data-p]');
  const marked = hit && root.contains(hit) ? hit : undefined;
  let best: { el: Element; distance: number } | undefined;
  if (!marked) {
    for (const el of root.querySelectorAll('[data-p]')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const dx = Math.max(r.left - event.clientX, 0, event.clientX - r.right);
      const dy = Math.max(r.top - event.clientY, 0, event.clientY - r.bottom);
      const distance = Math.hypot(dx, dy * 2);
      if (!best || distance < best.distance) best = { el, distance };
    }
  }
  const el = marked ?? best?.el;
  if (!el || !Number.isFinite(offset(el))) return undefined;
  // In the right half of a one-character symbol: behind it.
  const r = el.getBoundingClientRect();
  const single = (el.textContent ?? '').length <= 1;
  return offset(el) + (single && event.clientX > r.left + r.width / 2 ? 1 : 0);
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly from: number,
    /** Length of the mark in front of the TeX (`$` or `$$`). */
    readonly mark = 1,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = `cm-pm-math pm-math ${this.display ? 'is-display' : 'is-inline'}`;
    el.textContent = this.tex;
    void view.state.facet(previewDeps)?.reader?.renderMath(this.tex, this.display, el);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // The cursor goes to the part of the formula that was clicked.
      const at = texOffsetAt(el, e as MouseEvent);
      view.dispatch({ selection: { anchor: view.posAtDOM(el) + this.mark + (at ?? 0) } });
      view.focus();
    });
    return el;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Copies text and shows for a moment that it did. */
export function copyButton(text: () => string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pm-copy-button';
  button.title = 'Copy';
  button.setAttribute('aria-label', 'Copy');
  button.append(createIcon('copy', 13));
  // Not a click into the text.
  button.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(text()).then(() => {
      button.replaceChildren(createIcon('check', 13));
      button.classList.add('is-done');
      setTimeout(() => {
        button.replaceChildren(createIcon('copy', 13));
        button.classList.remove('is-done');
      }, 1200);
    });
  });
  return button;
}

/** In place of a code block's opening fence: its language, and a button to copy the code. */
class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }

  override eq(other: CodeHeaderWidget): boolean {
    return other.lang === this.lang && other.code === this.code;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-pm-code-header';
    const label = document.createElement('span');
    label.className = 'cm-pm-code-lang';
    label.append(createIcon('code', 12), ` ${this.lang || 'text'}`);
    el.append(
      label,
      copyButton(() => this.code),
    );
    return el;
  }

  override ignoreEvent(event: Event): boolean {
    // The button handles its own clicks; a click elsewhere puts the cursor on the fence.
    return !!(event.target as HTMLElement).closest?.('.pm-copy-button');
  }
}

/** What a formula gives, shown under its source while it is being written. */
class MathPreviewWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }

  override eq(other: MathPreviewWidget): boolean {
    return other.tex === this.tex;
  }

  private draw(view: EditorView, inner: HTMLElement): void {
    void view.state
      .facet(previewDeps)
      ?.reader?.renderMath(this.tex, true, inner)
      .then(() => view.requestMeasure());
  }

  toDOM(view: EditorView): HTMLElement {
    // An outer element without margins of its own (see the CSS note on blocks).
    const el = document.createElement('div');
    el.className = 'cm-pm-math-preview';
    const inner = document.createElement('div');
    inner.className = 'pm-math is-display';
    el.append(inner);
    this.draw(view, inner);
    return el;
  }

  /** Drawn again in place while typing, so the note does not jump. */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const inner = dom.querySelector<HTMLElement>(':scope > .pm-math');
    if (!inner) return false;
    this.draw(view, inner);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The inline formula the cursor is in, if any: where it starts and its TeX. */
function inlineMathAt(state: EditorState): { from: number; tex: string } | undefined {
  const sel = state.selection.main;
  if (!sel.empty) return undefined;
  for (let node = syntaxTree(state).resolveInner(sel.head, -1); ;) {
    if (node.name === 'InlineMath' || node.name === 'InlineMathDisplay') {
      const mark = node.name === 'InlineMath' ? 1 : 2;
      const tex = state.doc.sliceString(node.from + mark, node.to - mark);
      return tex.trim() ? { from: node.from, tex } : undefined;
    }
    if (!node.parent) return undefined;
    node = node.parent;
  }
}

/** While an inline formula is being written, what it gives floats under it. */
const inlineMathPreview = StateField.define<Tooltip | null>({
  create: () => null,
  update(tooltip, tr) {
    const math = inlineMathAt(tr.state);
    if (!math || !tr.state.facet(previewDeps)?.reader) return null;
    // The same formula as before (typing inside it): the same box, drawn again by itself.
    if (tooltip && tr.changes.mapPos(tooltip.pos) === math.from && tooltip.pos === math.from)
      return tooltip;
    return {
      pos: math.from,
      above: false,
      arrow: false,
      create(view) {
        const dom = document.createElement('div');
        dom.className = 'cm-pm-math-tip pm-math is-inline';
        let shown = '';
        const draw = (state: EditorState) => {
          const now = inlineMathAt(state);
          if (!now || now.tex === shown) return;
          shown = now.tex;
          void state.facet(previewDeps)?.reader?.renderMath(now.tex, false, dom);
        };
        draw(view.state);
        return { dom, update: (update) => draw(update.state) };
      },
    };
  },
  provide: (field) => showTooltip.from(field),
});

// Numbered figures, tables and equations of the note, by the line they start on. Counted once
// per version of the text.
const numbered = new WeakMap<object, Map<number, NumberedItem[]>>();
function itemsByLine(state: EditorState): Map<number, NumberedItem[]> {
  let map = numbered.get(state.doc);
  if (!map) {
    map = new Map();
    for (const item of numberItems(state.doc.toString())) {
      const at = map.get(item.line);
      if (at) at.push(item);
      else map.set(item.line, [item]);
    }
    numbered.set(state.doc, map);
  }
  return map;
}
/** The numbered item that starts at `pos` (an embed), or on its line (a block). */
function itemAt(state: EditorState, pos: number, kind: FigureKind, exact = false) {
  const line = state.doc.lineAt(pos);
  return itemsByLine(state)
    .get(line.number - 1)
    ?.find((i) => i.kind === kind && (!exact || i.column === pos - line.from));
}

/** Puts the caption (and number) under an embedded picture, video or frame. */
function setCaption(host: HTMLElement, label: string | undefined, caption: string | undefined) {
  host.querySelector(':scope > .cm-pm-caption')?.remove();
  if (!label && !caption) return;
  const el = document.createElement('span');
  el.className = 'cm-pm-caption';
  if (label) {
    const number = document.createElement('span');
    number.className = 'cm-pm-caption-label';
    number.textContent = caption ? `${label}: ` : label;
    el.append(number);
  }
  if (caption) el.append(caption);
  host.append(el);
}

/** Text standing in for something of the note (the number of a table in its caption line). */
class LabelWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: LabelWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-pm-caption-label';
    el.textContent = this.text;
    return el;
  }
}

const embedOf = new WeakMap<HTMLElement, EmbedWidget>();

class EmbedWidget extends WidgetType {
  private disposable: { dispose(): void } | undefined;

  constructor(
    readonly target: string,
    readonly subpath: string | undefined,
    readonly alias: string | undefined,
    readonly sourcePath: string,
    /** "Figure 2", if it is a numbered figure. */
    readonly label?: string,
  ) {
    super();
  }

  private same(other: EmbedWidget): boolean {
    return (
      other.target === this.target &&
      other.subpath === this.subpath &&
      other.alias === this.alias &&
      other.sourcePath === this.sourcePath
    );
  }

  override eq(other: EmbedWidget): boolean {
    return this.same(other) && other.label === this.label;
  }

  private get caption(): string | undefined {
    return isFigureTarget(this.target) ? embedCaption(this.alias) : undefined;
  }

  /** Only the number changed (a figure was added above): what is shown stays. */
  override updateDOM(dom: HTMLElement): boolean {
    const shown = embedOf.get(dom);
    if (!shown || !this.same(shown)) return false;
    embedOf.set(dom, this);
    setCaption(dom, this.label, this.caption);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    // An embed with a width keeps it when several stand on one line; the others share the rest.
    el.className = `cm-pm-embed${parseEmbedSize(this.alias).width ? ' is-sized' : ''}`;
    embedOf.set(el, this);
    // The number may change while the embed stays (see `updateDOM`).
    const caption = () => {
      const now = embedOf.get(el) ?? this;
      setCaption(el, now.label, now.caption);
    };
    const reader = view.state.facet(previewDeps)?.reader;
    // Events inside the widget do not reach the editor's own handlers.
    el.addEventListener('contextmenu', (e) => {
      if (!el.querySelector('img, video, audio, iframe, .pm-excalidraw-embed')) return;
      const menu = view.state.facet(previewDeps)?.embedMenu;
      if (!menu) return;
      e.preventDefault();
      e.stopPropagation();
      menu(view, el, { x: e.clientX, y: e.clientY });
    });
    const menuAt = (at: { x: number; y: number }) =>
      view.state.facet(previewDeps)?.embedMenu?.(view, el, at);
    /** Puts the cursor into the embed's text, which shows it as source. */
    const editSource = () => {
      const start = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: start + 3 }, scrollIntoView: true });
      view.focus();
    };
    /** Writes a new size into the embed's text (`![[x.png|300]]`). */
    const resize = (size: Size) => {
      const line = view.state.doc.lineAt(view.posAtDOM(el));
      const pos = view.posAtDOM(el) - line.from;
      const edit = embedSizeEdit(line.text, pos, size, setEmbedSize);
      if (!edit) return;
      view.dispatch({
        changes: { from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert },
        userEvent: 'input.resize',
      });
    };
    if (reader) {
      void reader
        .renderEmbed({
          target: this.target,
          ...(this.subpath ? { subpath: this.subpath } : {}),
          ...(this.alias !== undefined ? { alias: this.alias } : {}),
          sourcePath: this.sourcePath,
          depth: 0,
          container: el,
          // The embed's size may have changed: let the editor measure again.
          onDidRender: () => {
            view.requestMeasure();
            caption();
            attachResizeHandle(view, el, resize);
            attachMenuButton(el, menuAt, editSource);
          },
        })
        .then((d) => {
          this.disposable = d;
          view.requestMeasure();
          caption();
          attachResizeHandle(view, el, resize);
          attachMenuButton(el, menuAt, editSource);
        });
    }
    return el;
  }

  override destroy(): void {
    this.disposable?.dispose();
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** A table, math block or frontmatter rendered as a block; clicking it reveals the source. */
/** Where a rendered block is in the note and what it was rendered from, kept current. */
const blockOf = new WeakMap<HTMLElement, { source: string; from: number }>();

class BlockWidget extends WidgetType {
  constructor(
    readonly kind: 'table' | 'math' | 'properties' | 'code',
    readonly source: string,
    readonly from: number,
    /** "Figure 2" for a frame block, "(3)" for an equation, if it is numbered. */
    readonly label?: string,
  ) {
    super();
  }

  override eq(other: BlockWidget): boolean {
    return (
      other.kind === this.kind &&
      other.source === this.source &&
      other.from === this.from &&
      other.label === this.label
    );
  }

  /** The number is drawn by the style sheet from this (it can change while the block stays). */
  private applyLabel(dom: HTMLElement): void {
    dom.toggleAttribute('data-figure', !!this.label);
    if (this.label) dom.style.setProperty('--pm-figure', JSON.stringify(this.label));
    else dom.style.removeProperty('--pm-figure');
  }

  /**
   * Keeps what is on screen when only the block's place in the note changed (text was typed
   * above it), or when its content can take the new source itself (a frame whose settings
   * changed): rendering anew would reload a frame and lose what the reader did in it.
   */
  override updateDOM(dom: HTMLElement): boolean {
    const known = blockOf.get(dom);
    if (!known || !dom.classList.contains(`cm-pm-block-${this.kind}`)) return false;
    if (known.source !== this.source) {
      if (this.kind !== 'code') return false;
      const content = dom.querySelector('.pm-code-render');
      const taken =
        !!content &&
        !content.dispatchEvent(
          new CustomEvent('pumice-block-source', { cancelable: true, detail: this.source }),
        );
      if (!taken) return false;
    }
    blockOf.set(dom, { source: this.source, from: this.from });
    this.applyLabel(dom);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const deps = view.state.facet(previewDeps);
    const el = document.createElement('div');
    el.className = `cm-pm-block cm-pm-block-${this.kind}`;
    blockOf.set(el, { source: this.source, from: this.from });
    this.applyLabel(el);
    const { kind } = this;
    if (this.kind === 'math') {
      const tex = this.source.replace(/^\$\$+/, '').replace(/\$\$+\s*$/, '');
      // Inner element: `.pm-math.is-display` has vertical margins (see the CSS note on blocks).
      const math = document.createElement('div');
      math.className = 'pm-math is-display';
      math.textContent = tex;
      el.append(math);
      void deps?.reader?.renderMath(tex, true, math);
    } else if (this.kind === 'table' && deps) {
      el.classList.add('pm-rendered');
      el.innerHTML = deps.syntax.renderHtml(deps.syntax.parse(this.source));
      for (const m of el.querySelectorAll<HTMLElement>('.pm-math')) {
        void deps.reader?.renderMath(m.dataset.tex ?? '', false, m);
      }
    } else if (this.kind === 'properties' && deps) {
      renderProperties(el, deps, this.source);
    } else if (this.kind === 'code' && deps?.reader) {
      // A fenced block with a renderer (mermaid, …): render it like the reading view does.
      void deps.reader.render(el, this.source, { sourcePath: deps.sourcePath() ?? '' }).then(() => {
        // A frame block can be sized: the size goes into its `width` and `height` lines.
        const attach = () =>
          attachResizeHandle(view, el, (size) => {
            const { source, from } = blockOf.get(el)!;
            const next = blockSizeEdit(source, size);
            if (next === source) return;
            view.dispatch({
              changes: { from, to: from + source.length, insert: next },
              userEvent: 'input.resize',
            });
          });
        const menu = () =>
          attachMenuButton(
            el,
            (at) => {
              const { source, from } = blockOf.get(el)!;
              deps.blockMenu?.(view, { from, to: from + source.length }, at);
            },
            () => {
              // The cursor inside the block shows its source.
              const { source, from } = blockOf.get(el)!;
              view.dispatch({
                selection: { anchor: Math.min(from + 4, from + source.length) },
                scrollIntoView: true,
              });
              view.focus();
            },
          );
        attach();
        menu();
        // The frame itself appears a moment after the block.
        el.addEventListener('pumice-resize', () => {
          attach();
          if (!el.querySelector(':scope > .cm-pm-embed-menu')) menu();
        });
      });
    }
    el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a') && (e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const { source, from } = blockOf.get(el)!;
      let anchor = kind === 'properties' ? Math.min(4, from + source.length) : from;
      if (kind === 'math') {
        // The cursor goes to the part of the formula that was clicked.
        const lead = /^\$\$+/.exec(source)?.[0].length ?? 0;
        const at = texOffsetAt(el, e);
        anchor = from + lead + (at ?? (source[lead] === '\n' ? 1 : 0));
      }
      view.dispatch({ selection: { anchor } });
      view.focus();
    });
    return el;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function renderProperties(outer: HTMLElement, deps: PreviewDeps, source: string): void {
  const el = document.createElement('div');
  el.className = 'cm-pm-properties-box';
  outer.append(el);
  const meta = deps.syntax.extract(source.endsWith('\n') ? source : `${source}\n`);
  const title = document.createElement('div');
  title.className = 'cm-pm-properties-title';
  title.textContent = 'Properties';
  el.append(title);
  if (meta.frontmatterError || !meta.frontmatter) {
    const err = document.createElement('div');
    err.className = 'cm-pm-properties-error';
    err.textContent = meta.frontmatterError
      ? `Invalid YAML: ${meta.frontmatterError.split('\n')[0]}`
      : 'No properties';
    el.append(err);
    return;
  }
  const table = document.createElement('div');
  table.className = 'cm-pm-properties-list';
  for (const [key, value] of Object.entries(meta.frontmatter)) {
    const row = document.createElement('div');
    row.className = 'cm-pm-property';
    if (key === 'id') row.classList.add('is-id');
    const k = document.createElement('span');
    k.className = 'cm-pm-property-key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'cm-pm-property-value';
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const chip = document.createElement('span');
      chip.className = Array.isArray(value) ? 'cm-pm-chip' : 'cm-pm-scalar';
      chip.textContent =
        item === null || item === undefined
          ? ''
          : typeof item === 'object'
            ? JSON.stringify(item)
            : String(item);
      v.append(chip);
    }
    row.append(k, v);
    table.append(row);
  }
  el.append(table);
}

// Unfocused editors render everything; focused ones reveal the cursor's lines (see revealedLines).

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const deps = state.facet(previewDeps);
  const active = revealedLines(state);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const rangeActive = (from: number, to: number) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
  const decorations: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => {
    if (from < to) decorations.push(Decoration.replace({}).range(from, to));
  };
  const lineClass = (pos: number, cls: string) => {
    decorations.push(Decoration.line({ class: cls }).range(state.doc.lineAt(pos).from));
  };
  const linesOf = (
    from: number,
    to: number,
    cls: (n: number, first: boolean, last: boolean) => string,
  ) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let n = first; n <= last; n++)
      lineClass(state.doc.line(n).from, cls(n, n === first, n === last));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        const heading = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(name);
        if (heading) {
          lineClass(node.from, `cm-pm-h cm-pm-h${heading[1]}`);
          return;
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent?.name ?? '';
          if (parent.startsWith('ATXHeading') && !isActive(node.from)) {
            const after =
              state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            hide(node.from, after);
          }
          return;
        }
        if (MARK_CLASSES[name]) {
          decorations.push(
            Decoration.mark({ class: MARK_CLASSES[name] }).range(node.from, node.to),
          );
          // A label (`^fig-loss`) is for linking, not for reading.
          if (name === 'BlockId' && !isActive(node.from) && node.to > node.from)
            decorations.push(Decoration.replace({}).range(node.from, node.to));
          if (name === 'Comment' || name === 'Tag' || name === 'BlockId') return false;
          return;
        }
        if (HIDDEN_MARKS.has(name)) {
          if (node.node.parent?.name !== 'FencedCode' && !isActive(node.from))
            hide(node.from, node.to);
          return;
        }
        if (name === 'InlineMath' || name === 'InlineMathDisplay') {
          // A `$$ … $$` formula over several lines is drawn as a block (see `buildBlocks`).
          if (
            name === 'InlineMathDisplay' &&
            state.doc.lineAt(node.from).number !== state.doc.lineAt(node.to).number
          ) {
            if (rangeActive(node.from, node.to))
              decorations.push(
                Decoration.mark({ class: 'cm-pm-math-source' }).range(node.from, node.to),
              );
            return false;
          }
          if (!rangeActive(node.from, node.to) && deps?.reader) {
            const mark = name === 'InlineMath' ? 1 : 2;
            const tex = state.doc.sliceString(node.from + mark, node.to - mark);
            // `$$ … $$` within a line of text is still a displayed formula: large, on a row
            // of its own between the text before and after it.
            const display = name === 'InlineMathDisplay';
            decorations.push(
              Decoration.replace({ widget: new MathWidget(tex, display, node.from, mark) }).range(
                node.from,
                node.to,
              ),
            );
          } else {
            decorations.push(
              Decoration.mark({ class: 'cm-pm-math-source' }).range(node.from, node.to),
            );
          }
          return false;
        }
        if (name === 'Embed') {
          const source = deps?.sourcePath();
          if (!rangeActive(node.from, node.to) && deps?.reader && source !== undefined) {
            const target = node.node.getChild('WikiLinkTarget');
            const sub = node.node.getChild('WikiLinkSubpath');
            const alias = node.node.getChild('WikiLinkAlias');
            const pipe = node.node.getChild('WikiLinkPipe');
            decorations.push(
              Decoration.replace({
                widget: new EmbedWidget(
                  target ? state.doc.sliceString(target.from, target.to).trim() : '',
                  sub ? state.doc.sliceString(sub.from + 1, sub.to).trim() || undefined : undefined,
                  alias
                    ? state.doc.sliceString(alias.from, alias.to).trim()
                    : pipe
                      ? ''
                      : undefined,
                  source,
                  ((item) => (item ? figureLabel(item) : undefined))(
                    itemAt(state, node.from, 'fig', true),
                  ),
                ),
              }).range(node.from, node.to),
            );
          }
          return false;
        }
        if (name === 'CommentBlock') {
          linesOf(node.from, node.to, () => 'cm-pm-comment-line');
          return false;
        }
        if (name === 'Link') {
          const marks = node.node.getChildren('LinkMark');
          const url = node.node.getChild('URL');
          // Only inline links `[text](url)` render as links; references stay as they are.
          if (marks.length >= 2 && url) {
            const textFrom = marks[0]!.to;
            const textTo = marks[1]!.from;
            const href = state.doc.sliceString(url.from, url.to);
            if (textFrom < textTo) {
              decorations.push(
                Decoration.mark({
                  class: 'cm-pm-link',
                  attributes: { 'data-href': href, title: `${href} — ⌘/Ctrl-click to open` },
                }).range(textFrom, textTo),
              );
            }
            if (!isActive(node.from)) {
              hide(node.from, textFrom);
              hide(textTo, node.to);
            }
          }
          return false;
        }
        if (name === 'URL' && node.node.parent?.name === 'Autolink') {
          decorations.push(
            Decoration.mark({
              class: 'cm-pm-link',
              attributes: { 'data-href': state.doc.sliceString(node.from, node.to) },
            }).range(node.from, node.to),
          );
          return;
        }
        if (name === 'Blockquote') {
          const type = calloutTypeAt(
            state.doc.sliceString(node.from, Math.min(node.to, node.from + 200)),
            0,
          );
          if (type) {
            const { color } = calloutStyle(type);
            linesOf(node.from, node.to, (_n, first, last) =>
              [
                'cm-pm-callout',
                `cm-pm-callout-${color}`,
                first ? 'cm-pm-callout-first' : '',
                last ? 'cm-pm-callout-last' : '',
              ]
                .join(' ')
                .trim(),
            );
            const firstLine = state.doc.lineAt(node.from);
            const m = /^(>[ \t]?)(\[![^\]\s]+\][+-]?)/.exec(firstLine.text);
            if (m && !isActive(node.from)) {
              const markerFrom = firstLine.from + m[1]!.length;
              decorations.push(
                Decoration.replace({ widget: new CalloutIconWidget(type) }).range(
                  markerFrom,
                  markerFrom + m[2]!.length,
                ),
              );
            }
          } else {
            linesOf(node.from, node.to, () => 'cm-pm-quote');
          }
          return;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          linesOf(node.from, node.to, (_n, first, last) =>
            [
              'cm-pm-codeblock',
              first ? 'cm-pm-codeblock-first' : '',
              last ? 'cm-pm-codeblock-last' : '',
            ]
              .join(' ')
              .trim(),
          );
          // A code block that is not being edited: its fences give way to a header with the
          // language and a copy button.
          if (name === 'FencedCode' && !rangeActive(node.from, node.to)) {
            const first = state.doc.lineAt(node.from);
            const last = state.doc.lineAt(node.to);
            const open = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/.exec(first.text);
            const lang = open?.[2] ?? '';
            if (open && !deps?.reader?.hasCodeBlockRenderer(lang.toLowerCase())) {
              const closed = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
              const code =
                last.number > first.number
                  ? state.doc.sliceString(first.to + 1, closed ? last.from - 1 : last.to)
                  : '';
              decorations.push(
                Decoration.replace({ widget: new CodeHeaderWidget(lang, code) }).range(
                  first.from,
                  first.to,
                ),
              );
              if (closed) {
                hide(last.from, last.to);
                lineClass(last.from, 'cm-pm-codeblock-close');
              }
            }
          }
          return;
        }
        if (name === 'TaskMarker') {
          if (!isActive(node.from)) {
            const checked =
              state.doc.sliceString(node.from + 1, node.from + 2).toLowerCase() === 'x';
            decorations.push(
              Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(
                node.from,
                node.to,
              ),
            );
          }
          if (state.doc.sliceString(node.from + 1, node.from + 2).toLowerCase() === 'x') {
            lineClass(node.from, 'cm-pm-task-done');
          }
          return;
        }
        if (name === 'HorizontalRule' && !isActive(node.from)) {
          decorations.push(
            Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to),
          );
          return;
        }
        if (name === 'Frontmatter') {
          const end = state.doc.sliceString(node.to - 1, node.to) === '\n' ? node.to - 1 : node.to;
          linesOf(node.from, end, () => 'cm-pm-frontmatter');
          return false;
        }
        if (name === 'QuoteMark') {
          if (!isActive(node.from)) {
            const after =
              state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            hide(node.from, after);
          }
          return;
        }
        if (name === 'ListMark' && node.node.parent?.parent?.name === 'BulletList') {
          // Task items show only their checkbox.
          if (node.node.nextSibling?.name === 'Task' && !isActive(node.from)) {
            hide(node.from, node.node.nextSibling.from);
            return;
          }
          // A dot also on the line being edited, unless the cursor is right at the dash (or
          // the dash is selected): then the dash can be changed.
          const sel = state.selection.main;
          const atMark = sel.empty
            ? sel.head === node.from || sel.head === node.to
            : sel.from <= node.to && sel.to >= node.from;
          if (!isActive(node.from) || !atMark) {
            decorations.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
            );
          }
          return;
        }
      },
    });
  }
  // A table's caption line: "Table: …" reads "Table 2: …" unless it is being edited.
  for (const items of itemsByLine(state).values()) {
    for (const item of items) {
      if (item.kind !== 'tab' || item.captionLine === undefined) continue;
      if (item.captionLine + 1 > state.doc.lines) continue;
      const line = state.doc.line(item.captionLine + 1);
      const at = line.text.search(/Table:/i);
      if (at < 0) continue;
      decorations.push(Decoration.line({ class: 'cm-pm-caption-line' }).range(line.from));
      if (!isActive(line.from)) {
        decorations.push(
          Decoration.replace({ widget: new LabelWidget(`${figureLabel(item)}:`) }).range(
            line.from + at,
            line.from + at + 'Table:'.length,
          ),
        );
      }
    }
  }
  // Something replaced within a line must stay within it: while a note is being typed, the
  // parser may briefly pair marks across lines (a `$` with one further down), and a
  // replacement over a line break breaks the editor's drawing.
  const { doc } = view.state;
  return Decoration.set(
    decorations.filter(
      // `point`: a replacement or a widget (marks and line classes may span lines).
      (r) => !(r.value.point && r.to > r.from) || doc.lineAt(r.from).to >= r.to,
    ),
    true,
  );
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        revealChanged(update.startState, update.state) ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        // Within a list item, whether the cursor is at the dash decides how it is drawn.
        (update.selectionSet &&
          [update.startState, update.state].some((s) =>
            /^\s*[-*+]\s/.test(s.doc.lineAt(s.selection.main.head).text),
          ))
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Tables, math blocks and frontmatter become block widgets (needs a state field: they span lines). */
function buildBlocks(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const active = revealedLines(state);
  const touches = (from: number, to: number) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
  const reader = state.facet(previewDeps)?.reader;
  const owned = state.facet(previewBlockOwners);
  // Top-level blocks only; the frontmatter wrapper nests the markdown document in `Body`.
  const visit = (cursor: TreeCursor) => {
    if (!cursor.firstChild()) return;
    do {
      const { name, from } = cursor;
      // Some block nodes end after their final line break; stay on the block's last line.
      const to =
        cursor.to > from && state.doc.sliceString(cursor.to - 1, cursor.to) === '\n'
          ? cursor.to - 1
          : cursor.to;
      if (name === 'Body' || name === 'Document') {
        visit(cursor.node.cursor());
        continue;
      }
      let kind: BlockWidget['kind'] | undefined =
        name === 'Table'
          ? 'table'
          : name === 'MathBlock'
            ? 'math'
            : name === 'Frontmatter'
              ? 'properties'
              : undefined;
      if (name === 'FencedCode' && reader) {
        const info = cursor.node.getChild('CodeInfo');
        const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : '';
        if (lang && reader.hasCodeBlockRenderer(lang)) kind = 'code';
      }
      if (kind === 'math' && !owned.has(name) && touches(from, to) && reader) {
        // A formula being written: its source stays, and what it gives is shown below it.
        const source = state.doc.sliceString(from, to);
        const tex = source.replace(/^\$\$+/, '').replace(/\$\$+\s*$/, '');
        if (tex.trim()) {
          decorations.push(
            Decoration.widget({
              widget: new MathPreviewWidget(tex),
              block: true,
              side: 1,
            }).range(state.doc.lineAt(to).to),
          );
        }
      }
      if (!kind || owned.has(name) || touches(from, to)) continue;
      // Block replacements must cover whole lines.
      const start = state.doc.lineAt(from).from;
      const end = state.doc.lineAt(to).to;
      decorations.push(
        Decoration.replace({
          widget: new BlockWidget(
            kind,
            state.doc.sliceString(start, end),
            start,
            kind === 'math'
              ? ((item) => (item ? figureReference(item) : undefined))(itemAt(state, start, 'eq'))
              : kind === 'code'
                ? ((item) => (item ? figureLabel(item) : undefined))(itemAt(state, start, 'fig'))
                : undefined,
          ),
          block: true,
        }).range(start, end),
      );
    } while (cursor.nextSibling());
  };
  visit(syntaxTree(state).topNode.cursor());
  // A `$$ … $$` formula with text right above or below it (no blank line) is part of that
  // paragraph for the parser, but a formula of its own for the reader: drawn as a block when it
  // has its lines to itself.
  if (reader && !owned.has('MathBlock')) {
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== 'InlineMathDisplay') return;
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        if (first.number === last.number) return;
        if (
          state.doc.sliceString(first.from, node.from).trim() ||
          state.doc.sliceString(node.to, last.to).trim()
        )
          return;
        const source = state.doc.sliceString(node.from, node.to);
        if (touches(node.from, node.to)) {
          const tex = source.replace(/^\$\$+/, '').replace(/\$\$+\s*$/, '');
          if (tex.trim()) {
            decorations.push(
              Decoration.widget({
                widget: new MathPreviewWidget(tex),
                block: true,
                side: 1,
              }).range(last.to),
            );
          }
          return;
        }
        decorations.push(
          Decoration.replace({
            widget: new BlockWidget(
              'math',
              source,
              node.from,
              ((item) => (item ? figureReference(item) : undefined))(
                itemAt(state, first.from, 'eq'),
              ),
            ),
            block: true,
          }).range(first.from, last.to),
        );
      },
    });
  }
  return Decoration.set(decorations, true);
}

const blockPreview = StateField.define<DecorationSet>({
  create: (state) => buildBlocks(state),
  update: (deco, tr) => {
    if (
      tr.docChanged ||
      tr.reconfigured ||
      revealChanged(tr.startState, tr.state) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return buildBlocks(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Live preview: syntax hidden except around the cursor, rich widgets elsewhere. */
/** A rendered block (an embedded frame, …) changed its height after it was drawn. */
const remeasure = EditorView.domEventHandlers({
  'pumice-resize': (_event, view) => {
    view.requestMeasure();
    return false;
  },
} as Parameters<typeof EditorView.domEventHandlers>[0]);

export const livePreview: Extension = [
  revealTracking,
  inlinePreview,
  blockPreview,
  inlineMathPreview,
  remeasure,
];

/** Line classes that also apply in source mode (heading sizes, code blocks). */
export const sourceModeStyling = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const decorations: Range<Decoration>[] = [];
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (node) => {
            const heading = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(node.name);
            if (heading) {
              decorations.push(
                Decoration.line({ class: `cm-pm-h cm-pm-h${heading[1]}` }).range(
                  view.state.doc.lineAt(node.from).from,
                ),
              );
            }
          },
        });
      }
      return Decoration.set(decorations, true);
    }
  },
  { decorations: (v) => v.decorations },
);
