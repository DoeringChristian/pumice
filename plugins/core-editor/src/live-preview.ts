import {
  applyEmbedSize,
  attachMenuButton,
  attachResizeHandle,
  blockCaptionEdit,
  blockSizeEdit,
  embedSizeEdit,
  type Size,
} from './resize';
import { syntaxTree } from '@codemirror/language';
import type { TreeCursor } from '@lezer/common';
import {
  Facet,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  RectangleMarker,
  WidgetType,
  keymap,
  layer,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import {
  calloutTypeAt,
  previewBlockOwners,
  revealChanged,
  revealedAt,
  revealedLines,
  revealTracking,
  type MarkdownSyntaxApi,
  type ReaderApi,
  type VaultPath,
  parseEmbedSize,
  setEmbedSize,
  embedCaption,
  setEmbedCaption,
  figureLabel,
  figureReference,
  isFigureTarget,
  numberItems,
  type FigureKind,
  type NumberedItem,
} from '@pumice/api';
import { typedInlineMathAt, withCaret } from './tex';
import { calloutStyle, createIcon } from '@pumice/ui';

/**
 * Media (a picture, a video, a drawing, a frame) is one element in the text: the cursor steps
 * over it and it stays drawn. Its source shows only when asked for with its "</>" button,
 * until the cursor leaves it again.
 */
export const showSource = StateEffect.define<{ from: number; to: number } | null>();
const sourceShown = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(showSource)) return effect.value;
    if (!value) return null;
    const shown = tr.docChanged
      ? { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) }
      : value;
    const sel = tr.state.selection.main;
    // The cursor left it: it is drawn again.
    if (sel.from < shown.from || sel.to > shown.to) return null;
    return shown.from === value.from && shown.to === value.to ? value : shown;
  },
});
const sourceShownAt = (state: EditorState, from: number, to: number): boolean => {
  const shown = state.field(sourceShown, false);
  return !!shown && shown.from <= to && shown.to >= from;
};

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
  /** Starts a comment on a piece of the note (absent where there are no comments). */
  comment?(view: EditorView, range: { from: number; to: number }): void;
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

/** The note a formula is in: its own preamble applies. */
export function formulaSource(deps: PreviewDeps | undefined): { sourcePath?: VaultPath } {
  const path = deps?.sourcePath();
  return path !== undefined ? { sourcePath: path } : {};
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
  // In the right half of the symbol: behind it (behind all of `\alpha`, not its backslash).
  const r = el.getBoundingClientRect();
  const length = Number((el as HTMLElement).dataset.n) || 1;
  return offset(el) + (event.clientX > r.left + r.width / 2 ? length : 0);
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
    const deps = view.state.facet(previewDeps);
    void deps?.reader?.renderMath(this.tex, this.display, el, formulaSource(deps));
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

/** Where the TeX of a preview starts in the note, kept current as the preview is redrawn. */
const previewStart = new WeakMap<HTMLElement, number>();

/** What a formula gives, shown under its source while it is being written. */
class MathPreviewWidget extends WidgetType {
  constructor(
    readonly tex: string,
    /** Where the TeX starts in the note: a click on a symbol puts the cursor at its source. */
    readonly texFrom: number,
  ) {
    super();
  }

  override eq(other: MathPreviewWidget): boolean {
    return other.tex === this.tex && other.texFrom === this.texFrom;
  }

  private draw(view: EditorView, inner: HTMLElement): void {
    const deps = view.state.facet(previewDeps);
    void deps?.reader
      ?.renderMath(this.tex, true, inner, formulaSource(deps))
      .then(() => view.requestMeasure());
  }

  toDOM(view: EditorView): HTMLElement {
    // An outer element without margins of its own (see the CSS note on blocks).
    const el = document.createElement('div');
    el.className = 'cm-pm-math-preview';
    const inner = document.createElement('div');
    inner.className = 'pm-math is-display';
    el.append(inner);
    previewStart.set(el, this.texFrom);
    el.addEventListener('mousedown', (e) => {
      const at = texOffsetAt(el, e);
      if (at === undefined) return;
      e.preventDefault();
      view.dispatch({
        selection: { anchor: (previewStart.get(el) ?? 0) + at },
        userEvent: 'select.pointer',
      });
      view.focus();
    });
    this.draw(view, inner);
    return el;
  }

  /** Drawn again in place while typing, so the note does not jump. */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const inner = dom.querySelector<HTMLElement>(':scope > .pm-math');
    if (!inner) return false;
    previewStart.set(dom, this.texFrom);
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
    // A `$$ … $$` formula has its preview under it (see `buildBlocks`), not floating.
    if (node.name === 'InlineMathDisplay') return undefined;
    if (node.name === 'InlineMath') {
      const mark = 1;
      const tex = state.doc.sliceString(node.from + mark, node.to - mark);
      return tex.trim() ? { from: node.from, tex } : undefined;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  // One that ends in a space at the moment, with the cursor at its end: still a formula
  // while it is written.
  const typed = typedInlineMathAt(state);
  return typed ? { from: typed.from, tex: typed.tex } : undefined;
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
      // Above: under the formula it would cover the rest of a paragraph that is being written.
      above: true,
      // A tail that points at the formula, as on a speech bubble.
      arrow: true,
      create(view) {
        const dom = document.createElement('div');
        dom.className = 'cm-pm-math-tip';
        // The formula has an element of its own: the tail is the bubble's other child.
        const math = document.createElement('div');
        math.className = 'cm-pm-math-tip-formula pm-math is-inline';
        dom.append(math);
        let shown = '';
        const draw = (state: EditorState) => {
          const now = inlineMathAt(state);
          if (!now) return;
          // With a mark where the cursor is in the source.
          const caret = state.selection.main.head - (now.from + 1);
          const tex = caret >= 0 && caret <= now.tex.length ? withCaret(now.tex, caret) : now.tex;
          if (tex === shown) return;
          shown = tex;
          const deps = state.facet(previewDeps);
          void deps?.reader?.renderMath(tex, false, math, formulaSource(deps));
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

/** Whether a mouse button (or a finger) is down at the moment. */
let pointerDown = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (pointerDown = true), true);
  for (const type of ['pointerup', 'pointercancel'])
    window.addEventListener(type, () => (pointerDown = false), true);
  // The window itself losing the focus (not a field in it: their `blur` passes here too).
  window.addEventListener('blur', (e) => {
    if (e.target === window) pointerDown = false;
  });
}

/** Writes a caption that was edited under a figure into the note. */
const captionEdits = new WeakMap<HTMLElement, (caption: string) => void>();

/**
 * Makes a caption editable where it stands, as the text it is (no box in its place: nothing
 * around it moves when the editing starts or ends). Enter or leaving it keeps what was
 * written, Escape leaves the caption as it was. Call it from the `mousedown` that starts the
 * editing, without preventing its default: the cursor then lands where the click was.
 */
function editCaption(
  slot: HTMLElement,
  current: string,
  commit: (caption: string) => void,
  done: () => void,
): void {
  // An offer of a caption ("Add a caption") makes room for the caption itself.
  if (!current) slot.textContent = '';
  slot.contentEditable = 'plaintext-only';
  slot.spellcheck = true;
  slot.classList.add('is-editing');
  slot.setAttribute('role', 'textbox');
  slot.setAttribute('aria-label', 'Caption');
  let finished = false;
  const stop = (e: Event) => e.stopPropagation();
  // The caption is not part of the note's text: nothing typed or clicked in it is the editor's.
  const mine = [
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'click',
    'paste',
    'cut',
    'copy',
    'compositionstart',
    'compositionend',
  ];
  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    const next = (slot.textContent ?? '').replace(/\s+/g, ' ').trim();
    slot.removeEventListener('keydown', onKey);
    slot.removeEventListener('blur', onBlur);
    const settle = () => {
      slot.removeAttribute('contenteditable');
      slot.removeAttribute('role');
      slot.classList.remove('is-editing');
      for (const type of mine) slot.removeEventListener(type, stop);
      if (!keep || next === current.trim()) done();
      else commit(next);
    };
    // Left by a click into the note: nothing changes on screen (and nothing in the note) until
    // that click is over. Whatever moved under the pressed button would turn the click into
    // a selection.
    if (!pointerDown) return settle();
    const after = () => {
      window.removeEventListener('pointerup', after, true);
      window.removeEventListener('pointercancel', after, true);
      setTimeout(settle);
    };
    window.addEventListener('pointerup', after, true);
    window.addEventListener('pointercancel', after, true);
  };
  const onKey = (e: KeyboardEvent) => {
    // "Select all" is all of the caption, not all of the note around it (what is typed next
    // would replace the note).
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(slot);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
      slot.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
      slot.blur();
    }
  };
  const onBlur = () => finish(true);
  slot.addEventListener('keydown', onKey);
  slot.addEventListener('blur', onBlur);
  for (const type of mine) slot.addEventListener(type, stop);
  // The click that started it puts the cursor where it was; an empty caption has no text to
  // click into.
  if (!current) setTimeout(() => slot.focus());
}

/**
 * Puts the caption (and number) under an embedded picture, video or frame. Where the caption
 * can be written into the note (see `captionEdits`), a click on it edits it in place, and a
 * figure without one offers the field when the pointer is on it.
 */
function setCaption(host: HTMLElement, label: string | undefined, caption: string | undefined) {
  host.querySelector(':scope > .cm-pm-caption')?.remove();
  const edit = captionEdits.get(host);
  if (!label && !caption && !edit) return;
  const el = document.createElement('span');
  el.className = 'cm-pm-caption';
  if (label) {
    const number = document.createElement('span');
    number.className = 'cm-pm-caption-label';
    number.textContent = caption || edit ? `${label}: ` : label;
    el.append(number);
  }
  const text = document.createElement('span');
  text.className = 'cm-pm-caption-text';
  if (caption) text.textContent = caption;
  el.append(text);
  if (edit) {
    el.classList.add('is-editable');
    if (!caption) {
      el.classList.add('is-empty');
      text.textContent = 'Add a caption';
    }
    text.title = 'Click to edit the caption';
    text.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      // Already being written: the click moves the cursor within it.
      if (text.isContentEditable) return;
      editCaption(text, caption ?? '', edit, () => setCaption(host, label, caption));
    });
  }
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

/** What draws an embed and keeps it current, to be released with its element. */
const embedRenders = new WeakMap<HTMLElement, { dispose(): void }>();

class EmbedWidget extends WidgetType {
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

  /**
   * What is shown stays when only what stands around it changed: its number (a figure was
   * added above), or the caption or size of a figure (written under it, or dragged). Drawing
   * it anew would load the picture again and make the note jump.
   */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const shown = embedOf.get(dom);
    if (!shown) return false;
    if (!this.same(shown)) {
      const sameFigure =
        shown.target === this.target &&
        shown.subpath === this.subpath &&
        shown.sourcePath === this.sourcePath &&
        isFigureTarget(this.target);
      if (!sameFigure) return false;
      const size = parseEmbedSize(this.alias);
      if (!applyEmbedSize(dom, size)) return false;
      dom.classList.toggle('is-sized', !!size.width);
      if (size.width) dom.style.setProperty('--embed-w', `${size.width}px`);
      else dom.style.removeProperty('--embed-w');
      const picture = dom.querySelector<HTMLImageElement>(':scope > img');
      if (picture) picture.alt = this.caption ?? picture.alt;
      view.requestMeasure();
    }
    embedOf.set(dom, this);
    setCaption(dom, this.label, this.caption);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    // An embed with a width keeps it when several stand on one line; the others share the rest.
    const width = parseEmbedSize(this.alias).width;
    el.className = `cm-pm-embed${width ? ' is-sized' : ''}`;
    // Beside others on a line it may give a little, so that halves and thirds fit (see CSS).
    if (width) el.style.setProperty('--embed-w', `${width}px`);
    embedOf.set(el, this);
    // The number may change while the embed stays (see `updateDOM`).
    const caption = () => {
      const now = embedOf.get(el) ?? this;
      setCaption(el, now.label, now.caption);
    };
    // Only figures have captions (the alias of an embedded note is its title).
    if (isFigureTarget(this.target) && !view.state.readOnly)
      captionEdits.set(el, (text) => {
        const start = view.posAtDOM(el);
        let node = syntaxTree(view.state).resolveInner(start, 1);
        while (node.name !== 'Embed' && node.parent) node = node.parent;
        if (node.name !== 'Embed') return;
        const source = view.state.doc.sliceString(node.from, node.to);
        const inner = /^!\[\[([\s\S]*)\]\]$/.exec(source)?.[1];
        if (inner === undefined) return;
        view.dispatch({
          changes: { from: node.from, to: node.to, insert: `![[${setEmbedCaption(inner, text)}]]` },
          userEvent: 'input.caption',
        });
      });
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
      let node = syntaxTree(view.state).resolveInner(start, 1);
      while (node.name !== 'Embed' && node.parent) node = node.parent;
      const to = node.name === 'Embed' ? node.to : view.state.doc.lineAt(start).to;
      view.dispatch({
        selection: { anchor: Math.min(start + 3, to) },
        effects: showSource.of({ from: start, to }),
        scrollIntoView: true,
      });
      view.focus();
    };
    /** A comment on the embed, started from the picture itself. */
    const commentOn = view.state.facet(previewDeps)?.comment;
    const comment = commentOn
      ? () => {
          const start = view.posAtDOM(el);
          let node = syntaxTree(view.state).resolveInner(start, 1);
          while (node.name !== 'Embed' && node.parent) node = node.parent;
          const to = node.name === 'Embed' ? node.to : view.state.doc.lineAt(start).to;
          commentOn(view, { from: start, to });
        }
      : undefined;
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
            attachMenuButton(el, menuAt, editSource, comment);
          },
        })
        .then((d) => {
          embedRenders.set(el, d);
          view.requestMeasure();
          caption();
          attachResizeHandle(view, el, resize);
          attachMenuButton(el, menuAt, editSource, comment);
        });
    }
    return el;
  }

  /** By the element: the widget that is asked may be a later one that took the element over. */
  override destroy(dom: HTMLElement): void {
    embedRenders.get(dom)?.dispose();
    embedRenders.delete(dom);
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
      void deps?.reader?.renderMath(tex, true, math, formulaSource(deps));
    } else if (this.kind === 'table' && deps) {
      el.classList.add('pm-rendered');
      el.innerHTML = deps.syntax.renderHtml(deps.syntax.parse(this.source));
      for (const m of el.querySelectorAll<HTMLElement>('.pm-math')) {
        void deps.reader?.renderMath(m.dataset.tex ?? '', false, m, formulaSource(deps));
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
                effects: showSource.of({ from, to: from + source.length }),
                scrollIntoView: true,
              });
              view.focus();
            },
            deps.comment
              ? () => {
                  const { source, from } = blockOf.get(el)!;
                  deps.comment!(view, { from, to: from + source.length });
                }
              : undefined,
          );
        attach();
        menu();
        // A frame's caption is written where it is read: a click on it, or on the offer of
        // one under a frame that has none.
        if (/^\s*(`{3,}|~{3,})\s*frame\b/.test(this.source) && !view.state.readOnly) {
          const write = (caption: string) => {
            const { source, from } = blockOf.get(el)!;
            const next = blockCaptionEdit(source, caption);
            if (next !== source)
              view.dispatch({
                changes: { from, to: from + source.length, insert: next },
                userEvent: 'input.caption',
              });
          };
          const offer = document.createElement('span');
          offer.className = 'cm-pm-caption is-editable is-empty cm-pm-frame-caption-offer';
          const offerText = document.createElement('span');
          offerText.className = 'cm-pm-caption-text';
          offerText.textContent = 'Add a caption';
          offer.append(offerText);
          el.append(offer);
          el.addEventListener('mousedown', (e) => {
            const target = e.target as HTMLElement;
            const shown = target.closest<HTMLElement>('.pm-frame-caption');
            const slot = shown ?? (target.closest('.cm-pm-frame-caption-offer') ? offerText : null);
            if (!slot) return;
            e.stopPropagation();
            // Already being written: the click moves the cursor within it.
            if (slot.isContentEditable) return;
            const before = shown?.textContent ?? '';
            editCaption(slot, before, write, () => {
              slot.textContent = shown ? before : 'Add a caption';
            });
          });
        }
        // The frame itself appears a moment after the block.
        el.addEventListener('pumice-resize', () => {
          attach();
          if (!el.querySelector(':scope > .cm-pm-embed-menu')) menu();
        });
      });
    }
    el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a') && (e.metaKey || e.ctrlKey)) return;
      // A caption is edited where it stands (see above): the cursor stays out of it.
      if ((e.target as HTMLElement).closest('.pm-frame-caption, .cm-pm-caption')) return;
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
  // Most things give way to their source only when the cursor is in or right at them: the
  // rest of the line stays drawn. (Headings and blocks show their source for the whole line.)
  const near = (from: number, to: number) => revealedAt(state, from, to);
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
          if (name === 'BlockId' && !near(node.from, node.to) && node.to > node.from)
            decorations.push(Decoration.replace({}).range(node.from, node.to));
          if (name === 'Comment' || name === 'Tag' || name === 'BlockId') return false;
          return;
        }
        if (HIDDEN_MARKS.has(name)) {
          // The marks of the emphasis (code, …) the cursor is in.
          const parent = node.node.parent;
          if (parent && parent.name !== 'FencedCode' && !near(parent.from, parent.to))
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
          if (!near(node.from, node.to) && deps?.reader) {
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
          if (!sourceShownAt(state, node.from, node.to) && deps?.reader && source !== undefined) {
            const target = node.node.getChild('WikiLinkTarget');
            const sub = node.node.getChild('WikiLinkSubpath');
            const alias = node.node.getChild('WikiLinkAlias');
            const pipe = node.node.getChild('WikiLinkPipe');
            decorations.push(
              Decoration.replace({
                // One element for the cursor (see `embedAtoms`).
                atom: true,
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
            // The space between two embeds of a row is not drawn: text between the elements
            // of a row has no place on screen, and the cursor could not be kept there.
            const gap = /^[ \t]+(?=!\[\[)/.exec(
              state.doc.sliceString(node.to, state.doc.lineAt(node.to).to),
            );
            if (gap && !sourceShownAt(state, node.to, node.to + gap[0].length + 3))
              hide(node.to, node.to + gap[0].length);
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
            if (!near(node.from, node.to)) {
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
            const markerAt = firstLine.from + (m?.[1]?.length ?? 0);
            if (m && !near(markerAt, markerAt + m[2]!.length)) {
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
          // `- [ ]` as a whole: the source shows with the cursor at the dash or the box.
          const dash = node.node.parent?.prevSibling;
          if (!near(dash?.name === 'ListMark' ? dash.from : node.from, node.to)) {
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
          const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          if (!near(node.from, after)) hide(node.from, after);
          return;
        }
        if (name === 'ListMark' && node.node.parent?.parent?.name === 'BulletList') {
          // Task items show only their checkbox.
          const task = node.node.nextSibling;
          if (task?.name === 'Task') {
            const box = task.getChild('TaskMarker');
            if (!near(node.from, box?.to ?? task.from)) hide(node.from, task.from);
            return;
          }
          // A dot also on the line being edited, unless the cursor is right at the dash (or
          // the dash is selected): then the dash can be changed.
          if (!near(node.from, node.to)) {
            decorations.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
            );
          }
          return;
        }
      },
    });
  }
  // The indentation of nested list items: each step is as wide as a marker with its space, so
  // a nested item starts under the text of the one above, and carries a faint line that shows
  // how far the list above it reaches.
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      const indent = /^[ \t]+/.exec(line.text)?.[0];
      if (!indent || indent.length === line.length) continue;
      let listed = false;
      for (let n = syntaxTree(state).resolveInner(line.from + indent.length, 1); ;) {
        if (n.name === 'FencedCode' || n.name === 'CodeBlock') {
          listed = false;
          break;
        }
        if (n.name === 'BulletList' || n.name === 'OrderedList') listed = true;
        if (!n.parent) break;
        n = n.parent;
      }
      if (!listed) continue;
      for (let i = 0; i < indent.length;) {
        // A step is a tab or two spaces; a single space left over is kept as it is.
        const length = indent[i] === '\t' ? 1 : indent[i + 1] === ' ' ? 2 : 1;
        if (indent[i] === '\t' || length === 2)
          decorations.push(
            Decoration.mark({ class: 'cm-pm-indent' }).range(line.from + i, line.from + i + length),
          );
        i += length;
      }
    }
  }
  // A formula that is being written and ends in a space right now looks like one all the same.
  const typedMath = typedInlineMathAt(state);
  if (typedMath)
    decorations.push(
      Decoration.mark({ class: 'cm-pm-math-source' }).range(typedMath.from, typedMath.to),
      // Its dollars are grey, as the parser's are.
      Decoration.mark({ class: 'cm-pm-math-mark' }).range(typedMath.from, typedMath.from + 1),
      Decoration.mark({ class: 'cm-pm-math-mark' }).range(typedMath.to - 1, typedMath.to),
    );
  // A table's caption line: "Table: …" reads "Table 2: …" unless it is being edited.
  for (const items of itemsByLine(state).values()) {
    for (const item of items) {
      if (item.kind !== 'tab' || item.captionLine === undefined) continue;
      if (item.captionLine + 1 > state.doc.lines) continue;
      const line = state.doc.line(item.captionLine + 1);
      const at = line.text.search(/Table:/i);
      if (at < 0) continue;
      decorations.push(Decoration.line({ class: 'cm-pm-caption-line' }).range(line.from));
      if (!near(line.from + at, line.from + at + 'Table:'.length)) {
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

    /** The embeds that are drawn: each is one element for the cursor. */
    atoms: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
      this.atoms = atomsOf(this.decorations);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(sourceShown, false) !== update.state.field(sourceShown, false) ||
        revealChanged(update.startState, update.state) ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        // Within a list item, whether the cursor is at the dash decides how it is drawn.
        (update.selectionSet &&
          [update.startState, update.state].some((s) =>
            /^\s*[-*+]\s/.test(s.doc.lineAt(s.selection.main.head).text),
          ))
      ) {
        this.decorations = buildDecorations(update.view);
        this.atoms = atomsOf(this.decorations);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** The replaced embeds among the decorations. */
function atomsOf(decorations: DecorationSet): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const cursor = decorations.iter();
  for (; cursor.value; cursor.next())
    if ((cursor.value.spec as { atom?: boolean }).atom)
      builder.add(cursor.from, cursor.to, cursor.value);
  return builder.finish();
}
const embedAtoms = EditorView.atomicRanges.of(
  (view) => view.plugin(inlinePreview)?.atoms ?? Decoration.none,
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
              widget: new MathPreviewWidget(tex, from + (/^\$\$+/.exec(source)?.[0].length ?? 0)),
              block: true,
              side: 1,
            }).range(state.doc.lineAt(to).to),
          );
        }
      }
      // A rendered code block (a frame, …) is media: its source shows only when asked for.
      const revealed = kind === 'code' ? sourceShownAt(state, from, to) : touches(from, to);
      if (!kind || owned.has(name) || revealed) continue;
      // Block replacements must cover whole lines.
      const start = state.doc.lineAt(from).from;
      const end = state.doc.lineAt(to).to;
      decorations.push(
        Decoration.replace({
          // A rendered code block is one element for the cursor (see `mediaKeys`).
          ...(kind === 'code' ? { media: true } : {}),
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
        const preview = () => {
          const source = state.doc.sliceString(node.from, node.to);
          const lead = /^\$\$+/.exec(source)?.[0].length ?? 0;
          const tex = source.slice(lead).replace(/\$\$+\s*$/, '');
          if (!tex.trim()) return;
          decorations.push(
            Decoration.widget({
              widget: new MathPreviewWidget(tex, node.from + lead),
              block: true,
              side: 1,
            }).range(last.to),
          );
        };
        // Within one line it is drawn in place; while it is written, what it gives shows
        // under the line, as for a block.
        if (first.number === last.number) {
          if (revealedAt(state, node.from, node.to)) preview();
          return;
        }
        if (
          state.doc.sliceString(first.from, node.from).trim() ||
          state.doc.sliceString(node.to, last.to).trim()
        )
          return;
        const source = state.doc.sliceString(node.from, node.to);
        if (touches(node.from, node.to)) {
          preview();
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
      tr.startState.field(sourceShown, false) !== tr.state.field(sourceShown, false) ||
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

/**
 * The arrow keys move into a drawn formula block as into its source, the same from both
 * sides: from the line below, up lands on its last line, which then shows the source, and
 * down from the line above on its first. (Media is one element and is stepped over.)
 */
const intoDrawn = (dir: -1 | 1) => (view: EditorView) => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const n = line.number + dir;
  if (n < 1 || n > state.doc.lines) return false;
  // Within a paragraph that wraps, the keys move within it.
  if (state.doc.lineAt(view.moveVertically(sel, dir > 0).head).number === line.number) return false;
  const next = state.doc.line(n);
  // A formula block drawn in place of the next line (media is stepped over, not entered).
  let first = next;
  let last = next;
  let drawn = false;
  state.field(blockPreview, false)?.between(next.from, next.to, (from, to) => {
    if (to <= from || from > next.from || to < next.to) return;
    if (!/^\s*\$\$/.test(state.doc.lineAt(from).text)) return;
    drawn = true;
    first = state.doc.lineAt(from);
    last = state.doc.lineAt(to);
  });
  if (!drawn) return false;
  // As in the source: the next line, at the same column.
  const target = dir < 0 ? last : first;
  const anchor = Math.min(target.to, target.from + (sel.head - line.from));
  view.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: 'select' });
  return true;
};
// ---- media as one element --------------------------------------------------------------------
//
// A picture, video, drawing or frame is one element in the text, whatever it is written as (an
// embed within a line, or a block of several lines). The cursor has exactly two places at it:
// before and after. These rules say so for every key, instead of leaving it to how each kind
// of widget happens to behave.

type Span = { from: number; to: number };

/** The drawn media block (a frame block, …) that `pos` is at or in. */
function blockMediaAt(state: EditorState, from: number, to = from): Span | undefined {
  let found: Span | undefined;
  state.field(blockPreview, false)?.between(from, to, (f, t, deco) => {
    if (found || t <= f || !(deco.spec as { media?: boolean }).media) return;
    found = { from: f, to: t };
  });
  return found;
}

/** The drawn embeds on a line, in order. */
function embedsOn(view: EditorView, line: { from: number; to: number }): Span[] {
  const out: Span[] = [];
  view
    .plugin(inlinePreview)
    ?.atoms.between(line.from, line.to, (f, t) => void out.push({ from: f, to: t }));
  return out;
}

/** Whether a line holds nothing but media (and the spaces between). */
function mediaOnly(view: EditorView, line: { from: number; to: number; text: string }): boolean {
  const embeds = embedsOn(view, line);
  if (!embeds.length) return false;
  let rest = line.text;
  for (const e of [...embeds].reverse())
    rest = rest.slice(0, e.from - line.from) + rest.slice(e.to - line.from);
  return !rest.trim();
}

/** The element on screen that stands for a piece of media in the text. */
function mediaElement(view: EditorView, span: Span): HTMLElement | undefined {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>('.cm-pm-embed, .cm-pm-block')) {
    // Embeds inside an embedded note are not in this text.
    if (el.parentElement?.closest('.cm-pm-embed, .cm-pm-block')) continue;
    try {
      if (view.posAtDOM(el) === span.from) return el;
    } catch {
      // Not (or no longer) part of the editor's content.
    }
  }
  return undefined;
}

/**
 * The media the cursor stands at: the element in front of it, the one behind it, or both when
 * it stands between two of a row.
 */
function mediaAtCursor(view: EditorView): { behind?: Span; front?: Span } | undefined {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return undefined;
  const head = sel.head;
  const block = blockMediaAt(state, head);
  if (block) return head === block.from ? { front: block } : { behind: block };
  const line = state.doc.lineAt(head);
  const embeds = embedsOn(view, line);
  if (!embeds.length) return undefined;
  // Only the space of a row may lie between the cursor and the element.
  const blank = (from: number, to: number) => !state.doc.sliceString(from, to).trim();
  let behind = embeds.find((e) => e.to === head);
  let front = embeds.find((e) => e.from === head);
  if (behind && !front) front = embeds.find((e) => e.from > head && blank(head, e.from));
  if (front && !behind)
    behind = [...embeds].reverse().find((e) => e.to < head && blank(e.to, head));
  if (!behind && !front) return undefined;
  return { ...(behind ? { behind } : {}), ...(front ? { front } : {}) };
}

/** Starts the blinking anew at every move, so the cursor is seen where it arrives. */
const caretTurn = new WeakMap<EditorView, { at: number; turn: boolean }>();

/**
 * The cursor beside a piece of media, drawn here: the editor's own has no place it could be
 * shown at there (the element stands for text that is not on screen). As tall as the element
 * it stands at; between two, as tall as the taller.
 */
const mediaCaret = layer({
  above: true,
  class: 'cm-pm-media-caret-layer',
  update: (update) =>
    update.docChanged ||
    update.selectionSet ||
    update.focusChanged ||
    update.viewportChanged ||
    update.geometryChanged,
  markers(view) {
    const at = view.hasFocus ? mediaAtCursor(view) : undefined;
    const behind = at?.behind && mediaElement(view, at.behind)?.getBoundingClientRect();
    const front = at?.front && mediaElement(view, at.front)?.getBoundingClientRect();
    view.dom.classList.toggle('cm-pm-at-media', !!(behind || front));
    if (!behind && !front) return [];
    const top = Math.min(behind?.top ?? Infinity, front?.top ?? Infinity);
    const bottom = Math.max(behind?.bottom ?? -Infinity, front?.bottom ?? -Infinity);
    // Between two: in the middle of the space between them.
    const x =
      behind && front && front.left >= behind.right
        ? (behind.right + front.left) / 2 - 1
        : behind
          ? behind.right + 1
          : front!.left - 3;
    const head = view.state.selection.main.head;
    const last = caretTurn.get(view);
    const turn = last && last.at !== head ? !last.turn : (last?.turn ?? false);
    caretTurn.set(view, { at: head, turn });
    const base = view.scrollDOM.getBoundingClientRect();
    return [
      new RectangleMarker(
        `cm-pm-media-caret ${turn ? 'is-a' : 'is-b'}`,
        x - base.left + view.scrollDOM.scrollLeft,
        top - base.top + view.scrollDOM.scrollTop,
        null,
        Math.max(view.defaultLineHeight, bottom - top),
      ),
    ];
  },
});

/**
 * Puts the cursor at a place beside media. The editor is not asked to scroll there (it cannot
 * tell where that is and jumps): the element itself is brought into view if it is not.
 */
const moveTo = (view: EditorView, anchor: number) => {
  view.dispatch({ selection: { anchor }, userEvent: 'select' });
  const at = mediaAtCursor(view);
  const span = at?.behind ?? at?.front;
  const el = span && mediaElement(view, span);
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  else view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: 'nearest' }) });
  return true;
};

/** Left and right: across an element in one step. */
const acrossMedia = (dir: -1 | 1) => (view: EditorView) => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const head = sel.head;
  const block = blockMediaAt(state, head);
  if (block) {
    if (dir > 0)
      return moveTo(view, head < block.to ? block.to : Math.min(state.doc.length, block.to + 1));
    return moveTo(view, head > block.from ? block.from : Math.max(0, block.from - 1));
  }
  // Between two elements of a row there is one place, not one on each side of the space.
  const line = state.doc.lineAt(head);
  let at = head;
  if (dir > 0) while (at < line.to && /[ \t]/.test(state.doc.sliceString(at, at + 1))) at++;
  else while (at > line.from && /[ \t]/.test(state.doc.sliceString(at - 1, at))) at--;
  for (const e of embedsOn(view, line)) {
    if (dir > 0 && (head >= e.from || at === e.from) && head < e.to) return moveTo(view, e.to);
    if (dir < 0 && (head <= e.to || at === e.to) && head > e.from) return moveTo(view, e.from);
  }
  return false;
};

/**
 * Up and down: onto the line of an element, before it when the cursor comes from the start of
 * a line and after it otherwise; and on from an element to the line beyond it.
 */
const pastMedia = (dir: -1 | 1) => (view: EditorView) => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const head = sel.head;
  const line = state.doc.lineAt(head);
  const block = blockMediaAt(state, head);
  // Within a paragraph that wraps, the keys move within it.
  if (!block && !mediaOnly(view, line)) {
    if (state.doc.lineAt(view.moveVertically(sel, dir > 0).head).number === line.number)
      return false;
  }
  const edge = block ? state.doc.lineAt(dir > 0 ? block.to : block.from).number : line.number;
  const n = edge + dir;
  if (n < 1 || n > state.doc.lines) return false;
  const target = state.doc.line(n);
  const atStart = block ? head === block.from : head === line.from;
  const onward = blockMediaAt(state, target.from, target.to);
  if (onward) return moveTo(view, atStart ? onward.from : onward.to);
  if (mediaOnly(view, target)) return moveTo(view, atStart ? target.from : target.to);
  // From an element to ordinary text: its start going down, its end going up, or as it was.
  if (block || mediaOnly(view, line))
    return moveTo(view, atStart ? target.from : dir > 0 ? target.from : target.to);
  return false;
};

/** Text typed at a media block goes on a line of its own, before or after it. */
const typeAtMedia = EditorView.inputHandler.of((view, _from, _to, text) => {
  // Where the cursor is, not where the browser put the text (it sees the next line there).
  const sel = view.state.selection.main;
  if (!sel.empty || !text || text.includes('\n')) return false;
  const block = blockMediaAt(view.state, sel.head);
  if (!block) return false;
  const before = sel.head === block.from;
  view.dispatch({
    changes: before
      ? { from: block.from, insert: `${text}\n` }
      : { from: block.to, insert: `\n${text}` },
    selection: { anchor: before ? block.from + text.length : block.to + 1 + text.length },
    userEvent: 'input.type',
  });
  return true;
});

/** Backspace behind a media block, or Delete in front of it, removes the element. */
const deleteMedia = (forward: boolean) => (view: EditorView) => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const block = blockMediaAt(state, sel.head);
  if (!block) return false;
  const doc = state.doc;
  if (forward ? sel.head === block.from : sel.head === block.to) {
    // With the line break that held it, so no empty line is left behind.
    const to = Math.min(doc.length, block.to + 1);
    const from = to === block.to ? Math.max(0, block.from - 1) : block.from;
    view.dispatch({
      changes: { from, to },
      selection: { anchor: from },
      userEvent: forward ? 'delete.forward' : 'delete.backward',
    });
    return true;
  }
  // On the other side there is nothing of the element to delete: only an empty line goes.
  const beyond = forward ? block.to + 1 : block.from - 1;
  if (beyond < 0 || beyond > doc.length) return true;
  const other = doc.lineAt(beyond);
  if (other.length === 0) {
    view.dispatch({
      changes: forward ? { from: block.to, to: other.to } : { from: other.from, to: block.from },
      userEvent: forward ? 'delete.forward' : 'delete.backward',
    });
    return true;
  }
  return moveTo(view, beyond);
};

const formulaArrows = Prec.high(
  keymap.of([
    { key: 'ArrowLeft', run: acrossMedia(-1) },
    { key: 'ArrowRight', run: acrossMedia(1) },
    { key: 'ArrowUp', run: (view) => pastMedia(-1)(view) || intoDrawn(-1)(view) },
    { key: 'ArrowDown', run: (view) => pastMedia(1)(view) || intoDrawn(1)(view) },
    { key: 'Backspace', run: deleteMedia(false) },
    { key: 'Delete', run: deleteMedia(true) },
  ]),
);

export const livePreview: Extension = [
  revealTracking,
  // Before the previews, which read it.
  sourceShown,
  inlinePreview,
  blockPreview,
  inlineMathPreview,
  remeasure,
  formulaArrows,
  Prec.high(typeAtMedia),
  embedAtoms,
  mediaCaret,
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
