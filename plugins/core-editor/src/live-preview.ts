import {
  applyEmbedSize,
  attachMenuButton,
  attachResizeHandle,
  blockCaptionEdit,
  blockSizeEdit,
  type Size,
} from './resize';
import { completionStatus } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNodeRef, TreeCursor } from '@lezer/common';
import {
  EditorState as EditorStateClass,
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
  drawSelection,
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
  sizeEmbed,
  parseEmbedSize,
  embedCaption,
  figureLabel,
  drawnFor,
  figureReference,
  fillCaption,
  type LinksApi,
  type WikiLinkParts,
  isFigureTarget,
  mediaAt,
  embedSizeProperties,
  mediaSizeChanges,
  numberItems,
  type FigureKind,
  type NumberedItem,
} from '@pumice/api';
import { beginEmbedDrag, embedDrag } from './drag-embed';
import {
  captionAt,
  captionEditing,
  captionPlaces,
  enterCaption,
  frameCaption,
  hasCaptionPlace,
  type CaptionPlace,
} from './captions';
import { drawnHeights, heightAt } from './heights';
import { typedInlineMathAt, withCaret } from './tex';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
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
  /** Extensions for the text fields inside a note (see `Editor.registerFieldExtension`). */
  fieldExtensions?(): Extension[];
  /** Extensions for the field a caption is written in; `note`: the note's editor. */
  captionExtensions?(note: EditorView): Extension[];
  /** Links between notes: how one reads, and opening it. */
  links?(): LinksApi | undefined;
  /** Runs a command of the app (of another plugin, which may not be there). */
  run?(command: string, arg?: unknown): void;
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

/** What the vim keys keep on an editor, as far as it matters here. */
interface VimState {
  insertMode?: boolean;
  visualMode?: boolean;
  inputState?: { keyBuffer?: unknown[]; operator?: unknown; prefixRepeat?: unknown[] };
}
const vimOf = (view: EditorView): VimState | undefined =>
  (view as unknown as { cm?: { state?: { vim?: VimState } } }).cm?.state?.vim;
/** In normal mode with no command begun: a key is a command of its own. */
export const vimIdle = (view: EditorView): boolean => {
  const vim = vimOf(view);
  return (
    !!vim &&
    !vim.insertMode &&
    !vim.visualMode &&
    !vim.inputState?.keyBuffer?.length &&
    !vim.inputState?.operator &&
    !vim.inputState?.prefixRepeat?.length
  );
};

/**
 * A line of text outside the note (the note's name) as an editor of its own, for key bindings
 * that belong to the editor (vim mode). `done` gets the text when the field is left: with
 * Enter, with down (the arrow, or j in normal mode) or Escape in normal mode (`onward`), or
 * by the focus going elsewhere.
 */
export function lineField(
  parent: HTMLElement,
  text: string,
  extensions: Extension[],
  label: string,
  done: (text: string, onward: boolean) => void,
): EditorView {
  let finished = false;
  const finish = (view: EditorView, onward: boolean) => {
    if (finished) return;
    finished = true;
    const value = view.state.doc.toString().replace(/\s+/g, ' ').trim();
    view.destroy();
    done(value, onward);
  };
  const field = new EditorView({
    parent,
    state: EditorStateClass.create({
      doc: text,
      extensions: [
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(e, v) {
              if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
              // A list of suggestions is open: the keys choose from it.
              if (completionStatus(v.state) === 'active') return false;
              const idle = !vimOf(v) || vimIdle(v);
              if (
                e.key === 'Enter' ||
                e.key === 'ArrowDown' ||
                (e.key === 'Escape' && idle) ||
                (e.key === 'j' && vimIdle(v))
              ) {
                e.preventDefault();
                finish(v, true);
                return true;
              }
              return false;
            },
          }),
        ),
        ...extensions,
        history(),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        drawSelection(),
        EditorStateClass.transactionFilter.of((tr) =>
          tr.docChanged && tr.newDoc.lines > 1 ? [] : tr,
        ),
        EditorView.domEventHandlers({
          blur: (e, v) => {
            if (e.relatedTarget instanceof Node && v.dom.contains(e.relatedTarget)) return;
            finish(v, false);
          },
        }),
        EditorView.contentAttributes.of({ 'aria-label': label }),
      ],
    }),
  });
  field.dispatch({ selection: { anchor: field.state.doc.length } });
  field.focus();
  return field;
}

/**
 * The figure whose caption lies next in a direction: under the figure the cursor is at (down),
 * or at the bottom of the figure on the line above (up).
 */
function captionToward(view: EditorView, dir: -1 | 1): Span | undefined {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return undefined;
  if (dir > 0) return figureAtCursor(view);
  const head = sel.head;
  const line = state.doc.lineAt(head);
  const block = blockMediaAt(state, head);
  if (
    !block &&
    !mediaOnly(view, line) &&
    state.doc.lineAt(view.moveVertically(sel, false).head).number === line.number
  )
    return undefined;
  const n = (block ? state.doc.lineAt(block.from).number : line.number) - 1;
  if (n < 1) return undefined;
  const target = state.doc.line(n);
  const onward = blockMediaAt(state, target.from, target.to);
  if (onward) return onward;
  if (!mediaOnly(view, target)) return undefined;
  const embeds = embedsOn(view, target);
  const atStart = block ? head === block.from : head === line.from && line.length > 0;
  return atStart ? embeds[0] : embeds[embeds.length - 1];
}

/**
 * The figure the cursor is at: beside it, or on it (a cursor that stands on a character, as
 * in vim's normal mode, stands on the figure itself).
 */
function figureAtCursor(view: EditorView): Span | undefined {
  const sel = view.state.selection.main;
  if (!sel.empty) return undefined;
  const at = mediaAtCursor(view);
  return (
    at?.behind ??
    at?.front ??
    embedsOn(view, view.state.doc.lineAt(sel.head)).find(
      (e) => e.from <= sel.head && sel.head <= e.to,
    )
  );
}

/** The caption the cursor is in, as text of the note (not where its figure shows as source). */
function captionHere(state: EditorState): CaptionPlace | undefined {
  const place = captionAt(state, state.selection.main.head);
  return place && !sourceShownAt(state, place.from, place.to) ? place : undefined;
}

/** The caption of a drawn figure, if it has one. */
function captionOf(state: EditorState, span: Span): CaptionPlace | undefined {
  const place =
    frameCaption(state, span) ?? captionPlaces(state, span.from).find((p) => p.from === span.from);
  return place && state.sliceDoc(place.captionFrom, place.captionTo).trim() ? place : undefined;
}

/** Up or down into a figure's caption, if that is what lies there. For other key bindings. */
export function captionStep(view: EditorView, dir: -1 | 1): boolean {
  if (captionHere(view.state)) return false;
  const span = captionToward(view, dir);
  const place = span && captionOf(view.state, span);
  if (!place) return false;
  view.dispatch({
    selection: { anchor: dir > 0 ? place.captionFrom : place.captionTo },
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}

/** Starts writing the caption of the figure the cursor is at (a new one if it has none). */
export function editCaptionAtCursor(view: EditorView): boolean {
  const span = figureAtCursor(view);
  if (!span) return false;
  return blockMediaAt(view.state, span.from)
    ? enterFrameCaption(view, span)
    : enterCaption(view, span.from);
}

/** The same for a frame block: its caption is a line of it. */
function enterFrameCaption(view: EditorView, span: Span): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const place = frameCaption(state, span);
  if (place) view.dispatch({ selection: { anchor: place.captionTo }, userEvent: 'select' });
  else {
    const first = state.doc.lineAt(span.from);
    // Behind the line that says which file, or else the first.
    let after = first;
    for (let n = first.number + 1; n < state.doc.lineAt(span.to).number; n++)
      if (/^file[ \t]*:/.test(state.doc.line(n).text)) after = state.doc.line(n);
    view.dispatch({
      changes: { from: after.to, insert: '\ncaption: ' },
      selection: { anchor: after.to + 10 },
      userEvent: 'input.caption',
    });
  }
  view.focus();
  return true;
}

/** What is drawn for the figure, table or equation at `pos`, if it is. */
function drawnAt(view: EditorView, pos: number): HTMLElement | undefined {
  const embed = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-pm-embed')].find(
    (e) => view.posAtDOM(e) === pos,
  );
  if (embed) return embed;
  if (!view.visibleRanges.some((r) => r.from <= pos && pos <= r.to)) return undefined;
  const { node, offset } = view.domAtPos(pos, 1);
  const at = node.nodeType === 1 ? (node.childNodes[offset] ?? node) : node.parentElement;
  return (
    (at instanceof HTMLElement ? at : at?.parentElement)?.closest<HTMLElement>(
      '.pm-table-widget, .cm-pm-block, .cm-pm-embed, .cm-line',
    ) ?? undefined
  );
}

/** What scrolls the note: the editor, or what it stands in. */
function scrollerOf(view: EditorView): HTMLElement {
  for (let e: HTMLElement | null = view.scrollDOM; e; e = e.parentElement)
    if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY))
      return e;
  return view.scrollDOM;
}

/**
 * Brings the middle of what stands at `pos` to the middle of the window (its top to the top where
 * it is taller). All of it happens before anything is painted, so it is a single movement: what is
 * not drawn yet is drawn where it is expected, and then measured.
 */
function centreAt(view: EditorView, pos: number): HTMLElement | undefined {
  const scroller = scrollerOf(view);
  const frame = scroller.getBoundingClientRect();
  let el: HTMLElement | undefined;
  for (let tries = 0; tries < 6; tries++) {
    el = drawnAt(view, pos);
    let top: number;
    let height: number;
    if (el) {
      const box = (el.closest('.cm-pm-figure') ?? el).getBoundingClientRect();
      ({ top, height } = box);
    } else {
      const block = view.lineBlockAt(pos);
      top = view.documentTop + block.top;
      height = block.height;
    }
    const space = frame.height - height;
    const off = top - frame.top - (space > 32 ? space / 2 : 16);
    const before = scroller.scrollTop;
    if (Math.abs(off) > 1) scroller.scrollTop += off;
    if (el && Math.abs(scroller.scrollTop - before) <= 1) break;
    // (The editor draws what has come into view now, not in the next frame.)
    (view as unknown as { measure(): void }).measure();
  }
  return el;
}

/**
 * Keeps it there while it and what is around it find their size (a picture that loads), each time
 * before that is painted. Ends with the first thing the user does.
 */
function holdCentred(view: EditorView, pos: number, ms = 1500): void {
  const scroller = scrollerOf(view);
  const doc = view.state.doc;
  const done = new AbortController();
  const again = () => {
    if (done.signal.aborted) return;
    if (!view.dom.isConnected || view.state.doc !== doc) done.abort();
    else centreAt(view, pos);
  };
  const sizes = new ResizeObserver(again);
  const watch = () => {
    sizes.observe(view.contentDOM);
    const el = drawnAt(view, pos);
    if (el) sizes.observe(el);
  };
  const changes = new MutationObserver(() => {
    if (!done.signal.aborted) watch();
  });
  for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
    scroller.ownerDocument.addEventListener(type, () => done.abort(), {
      capture: true,
      passive: true,
      signal: done.signal,
    });
  const timer = setTimeout(() => done.abort(), ms);
  done.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    sizes.disconnect();
    changes.disconnect();
  });
  changes.observe(view.contentDOM, { childList: true, subtree: true });
  watch();
}

/** Goes to a figure, table or equation of the note and shows which it is. */
export function revealItem(view: EditorView, item: NumberedItem): void {
  const line = view.state.doc.line(Math.min(item.line + 1, view.state.doc.lines));
  const pos = line.from + (item.column ?? 0);
  // The cursor goes to a picture (it steps over it); inside a table or a formula it would
  // open it for writing, so those are only brought into view.
  if (item.column !== undefined) view.dispatch({ selection: { anchor: pos }, userEvent: 'select' });
  const el = centreAt(view, pos);
  holdCentred(view, pos);
  if (!el) return;
  el.classList.remove('pm-flash');
  // (Reading a size starts the animation anew.)
  void el.offsetWidth;
  el.classList.add('pm-flash');
  setTimeout(() => el.classList.remove('pm-flash'), 1400);
}

/** The label of a figure, shown beside its caption. */
const labelTags = new WeakMap<
  HTMLElement,
  { id(): string | undefined; rename(name: string): void }
>();
/** The label of a figure as a chip: a click renames it where it stands (references follow). */
function labelChip(view: EditorView, id: string, rename: (name: string) => void): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'cm-pm-caption-id';
  chip.textContent = `@${id}`;
  chip.title = 'Its label: click to rename it (references follow)';
  chip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = document.createElement('input');
    input.className = 'cm-pm-caption-id is-editing';
    input.value = id;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Label');
    const fit = () => (input.style.width = `${Math.max(6, input.value.length + 1)}ch`);
    fit();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      // Unchanged or given up: as it was. Renamed: the note changes, and it is drawn anew.
      if (input.isConnected) input.replaceWith(chip);
      if (keep && name && name !== id) rename(name);
    };
    input.addEventListener('input', fit);
    input.addEventListener('blur', () => finish(true));
    // The keys are the field's, not the editor's.
    for (const type of [
      'keydown',
      'keyup',
      'keypress',
      'mousedown',
      'click',
      'beforeinput',
      'input',
      'paste',
      'cut',
      'copy',
      'focusin',
    ] as const)
      input.addEventListener(type, (ev) => {
        ev.stopPropagation();
        if (type !== 'keydown') return;
        const key = (ev as KeyboardEvent).key;
        if (key !== 'Enter' && key !== 'Escape') return;
        ev.preventDefault();
        finish(key === 'Enter');
        // Back to the note (undo, say, is its).
        view.focus();
      });
    chip.replaceWith(input);
    input.focus();
    // The name behind `fig-` is what is usually changed.
    input.setSelectionRange(id.indexOf('-') + 1, id.length);
  });
  return chip;
}

/** In place of what stands behind a caption: the label of the figure. */
class LabelChipWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly pos: number,
  ) {
    super();
  }
  override eq(other: LabelChipWidget): boolean {
    return other.id === this.id && other.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    // The chip is in an element that stays: the editor takes a change of its own elements for a
    // change of the text they stand for (the chip is replaced by a field while it is edited).
    const el = document.createElement('span');
    el.className = 'cm-pm-caption-label-place';
    el.append(
      labelChip(view, this.id, (name) =>
        view.state.facet(previewDeps)?.run?.('links.rename-label', { pos: this.pos, name }),
      ),
    );
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** The references in the caption of a frame block (which is not parsed as text of the note). */
function referencesIn(
  state: EditorState,
  place: CaptionPlace,
): { from: number; to: number; id: string; text: string }[] {
  const text = state.sliceDoc(place.captionFrom, place.captionTo);
  const items = [...itemsByLine(state).values()].flat();
  return [
    ...text.matchAll(/\[\[#\^([A-Za-z0-9-]+)\]\]|(?<![A-Za-z0-9@])@([a-z]+-[A-Za-z0-9-]+)/gi),
  ].flatMap((m) => {
    const id = (m[1] ?? m[2])!;
    const item = items.find((i) => i.id === id);
    const from = place.captionFrom + m.index;
    return item ? [{ from, to: from + m[0].length, id, text: figureReference(item) }] : [];
  });
}

class CaptionReferenceWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly id: string,
  ) {
    super();
  }
  override eq(other: CaptionReferenceWidget): boolean {
    return other.text === this.text && other.id === this.id;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-pm-wikilink';
    el.textContent = this.text;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const item = [...itemsByLine(view.state).values()].flat().find((i) => i.id === this.id);
      if (item) revealItem(view, item);
    });
    return el;
  }
}

/** A caption that is begun: its place, until there is text in it. */
class EmptyCaptionWidget extends WidgetType {
  constructor(readonly label: string | undefined) {
    super();
  }
  override eq(other: EmptyCaptionWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-pm-caption is-text is-begun';
    if (this.label) el.dataset.label = `${this.label}: `;
    el.textContent = 'Write a caption';
    return el;
  }
}

/** Under a figure without a caption: its number, its label, and the offer of a caption. */
function setCaption(host: HTMLElement, view: EditorView, of: EmbedWidget): void {
  host.querySelector(':scope > .cm-pm-caption')?.remove();
  if (of.captioned || !isFigureTarget(of.target)) return;
  const offer = !view.state.readOnly;
  if (!of.label && !offer) return;
  const el = document.createElement('span');
  el.className = `cm-pm-caption${of.label ? '' : ' is-empty'}`;
  if (of.label) {
    const number = document.createElement('span');
    number.className = 'cm-pm-caption-label';
    number.textContent = of.label;
    el.append(number);
  }
  if (offer) {
    const text = document.createElement('span');
    text.className = 'cm-pm-caption-offer';
    text.textContent = of.label ? ': Add a caption' : 'Add a caption';
    text.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterCaption(view, view.posAtDOM(host));
    });
    el.append(text);
  }
  if (of.id)
    el.append(
      labelChip(view, of.id, (name) =>
        view.state
          .facet(previewDeps)
          ?.run?.('links.rename-label', { pos: view.posAtDOM(host), name }),
      ),
    );
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

/** What is drawn as an embed: `![[…]]`, and a Markdown image `![…](…)`. */
const isEmbedNode = (name: string) => name === 'Embed' || name === 'Image';
/** What is drawn at `el`, in the note's text. */
function embedNodeAt(view: EditorView, el: HTMLElement) {
  let node = syntaxTree(view.state).resolveInner(view.posAtDOM(el), 1);
  while (!isEmbedNode(node.name) && node.parent) node = node.parent;
  return isEmbedNode(node.name) ? node : undefined;
}

const embedOf = new WeakMap<HTMLElement, EmbedWidget>();

/** What draws an embed and keeps it current, to be released with its element. */
const embedRenders = new WeakMap<HTMLElement, { dispose(): void }>();

/**
 * Keeps the room something had when it was last drawn until it is there again. `drawn`: it has
 * been put into `el`, though what it shows (a picture, a video, a frame) may still load.
 */
function holdRoom(el: HTMLElement, height: number | undefined, drawn: Promise<unknown>): void {
  if (!height) return;
  el.style.minHeight = `${height}px`;
  const release = () => el.style.removeProperty('min-height');
  const once = (target: EventTarget, types: string[]) =>
    new Promise<void>((done) => {
      for (const type of types) target.addEventListener(type, () => done(), { once: true });
    });
  // Something that never comes does not leave a hole for good.
  setTimeout(release, 20_000);
  void drawn
    .catch(() => undefined)
    .then(() =>
      // All of it (an embedded note may hold several).
      Promise.all(
        [...el.querySelectorAll('img, video, iframe')].map(async (media) => {
          if (media instanceof HTMLImageElement && !media.complete)
            await once(media, ['load', 'error']);
          else if (media instanceof HTMLVideoElement && media.readyState < 1)
            await once(media, ['loadedmetadata', 'error']);
          else if (media instanceof HTMLIFrameElement) {
            // A frame says how high it is only after it has loaded.
            await Promise.race([
              once(media, ['load', 'error']),
              new Promise((done) => setTimeout(done, 5000)),
            ]);
            await new Promise((done) => setTimeout(done, 600));
          }
        }),
      ),
    )
    .then(() => requestAnimationFrame(release));
}

const embedMeasures = new WeakMap<HTMLElement, ResizeObserver>();

class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly subpath: string | undefined,
    readonly alias: string | undefined,
    readonly sourcePath: string,
    /** "Figure 2", if it is a numbered figure. */
    readonly label?: string,
    /** What it is referred to by (`fig-setup`), if it has a label. */
    readonly id?: string,
    /** Its caption is shown as text of the note, under it. */
    readonly captioned = false,
  ) {
    super();
  }

  /** Made for reading or for writing (see `drawnFor`). */
  readonly epoch = drawnFor.epoch;

  private same(other: EmbedWidget): boolean {
    return (
      other.target === this.target &&
      other.subpath === this.subpath &&
      other.alias === this.alias &&
      other.sourcePath === this.sourcePath
    );
  }

  override eq(other: EmbedWidget): boolean {
    return (
      this.same(other) &&
      other.label === this.label &&
      other.id === this.id &&
      other.captioned === this.captioned &&
      other.epoch === this.epoch
    );
  }

  private get key(): string {
    return [this.sourcePath, this.target, this.subpath ?? '', this.alias ?? ''].join('\n');
  }

  /** As high as it was when it was last on screen, so that the note keeps its length. */
  override get estimatedHeight(): number {
    return drawnHeights.get(this.key)?.height ?? -1;
  }

  private get hasCaption(): boolean {
    return isFigureTarget(this.target);
  }

  private get caption(): string | undefined {
    return this.hasCaption ? embedCaption(this.alias) : undefined;
  }

  /**
   * What is shown stays when only what stands around it changed: its number (a figure was
   * added above), or the caption or size of a figure (written under it, or dragged). Drawing
   * it anew would load the picture again and make the note jump.
   */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const shown = embedOf.get(dom);
    if (!shown || shown.epoch !== this.epoch) return false;
    if (!this.same(shown)) {
      const sameFigure =
        shown.target === this.target &&
        shown.subpath === this.subpath &&
        shown.sourcePath === this.sourcePath &&
        isFigureTarget(this.target);
      if (!sameFigure) return false;
      const size = parseEmbedSize(this.alias);
      if (!applyEmbedSize(dom, size)) return false;
      const picture = dom.querySelector<HTMLImageElement>(':scope > img');
      if (picture) picture.alt = this.caption ?? picture.alt;
      view.requestMeasure();
    }
    embedOf.set(dom, this);
    setCaption(dom, view, this);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    // (A figure is the box, with its caption in it.)
    el.className = `pm-embed cm-pm-embed${isFigureTarget(this.target) ? '' : ' pm-embed-box'}`;
    // (At once: several beside each other on a line stand by their widths.)
    sizeEmbed(el, parseEmbedSize(this.alias));
    embedOf.set(el, this);
    // Until what it shows has loaded again it keeps the room it had: the text under it
    // stays where it is, and so does the scroll bar.
    const known = heightAt(this.key, view.contentDOM.clientWidth);
    const measured = new ResizeObserver(() => {
      const now = embedOf.get(el);
      if (now && el.isConnected && el.offsetHeight > 0)
        drawnHeights.learn(now.key, {
          height: el.offsetHeight,
          width: view.contentDOM.clientWidth,
        });
    });
    measured.observe(el);
    embedMeasures.set(el, measured);
    // The number may change while the embed stays (see `updateDOM`).
    const caption = () => {
      const now = embedOf.get(el) ?? this;
      setCaption(el, view, now);
    };
    // It can be dragged to another place of the note.
    if (!view.state.readOnly) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => beginEmbedDrag(view, el, e));
      // What takes the pointer itself is not dragged away while it does.
      el.addEventListener('pointerdown', (e) => {
        if (!(e.target as HTMLElement).closest?.('[data-pm-interactive]')) return;
        el.draggable = false;
        const back = () => {
          el.draggable = true;
          window.removeEventListener('pointerup', back, true);
          window.removeEventListener('pointercancel', back, true);
        };
        window.addEventListener('pointerup', back, true);
        window.addEventListener('pointercancel', back, true);
      });
    }
    const reader = view.state.facet(previewDeps)?.reader;
    // Events inside the widget do not reach the editor's own handlers.
    el.addEventListener('contextmenu', (e) => {
      if (!el.querySelector('.pm-embed-media, audio, iframe')) return;
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
      const to = embedNodeAt(view, el)?.to ?? view.state.doc.lineAt(start).to;
      view.dispatch({
        selection: { anchor: Math.min(start + 3, to) },
        effects: showSource.of({ from: start, to }),
        scrollIntoView: true,
      });
      view.focus();
    };
    /** The embed as it is written in the note, with attributes behind it. */
    const sourceText = () => embedSource(view, el);
    /** A comment on the embed, started from the picture itself. */
    const commentOn = view.state.facet(previewDeps)?.comment;
    const comment = commentOn
      ? () => {
          const start = view.posAtDOM(el);
          const to = embedNodeAt(view, el)?.to ?? view.state.doc.lineAt(start).to;
          commentOn(view, { from: start, to });
        }
      : undefined;
    /** The changes that write a size into the text of the embed drawn at `host`. */
    const sizeChanges = (host: HTMLElement, size: Size, keep = false) => {
      const line = view.state.doc.lineAt(view.posAtDOM(host));
      const media = mediaAt(line.text, view.posAtDOM(host) - line.from);
      if (!media) return [];
      // (A height it has stays, unless the two only said its proportions: `|300x200`.)
      const { h, w } = media.size;
      const keeps = h && (h.unit || w?.unit || /\.html?$/i.test(media.target));
      const height = size.height ?? (keep && keeps ? `${h.value}${h.unit || 'px'}` : undefined);
      return mediaSizeChanges(line.text, media, {
        width: size.width,
        ...(height ? { height } : {}),
      }).map((c) => ({ ...c, from: line.from + c.from, to: line.from + c.to }));
    };
    const resize = (size: Size, row: Array<{ host: HTMLElement; width: number }> = []) => {
      const changes = [
        ...sizeChanges(el, size),
        // The others on its line, whose widths changed with it (a height one has stays).
        ...row.flatMap((o) => sizeChanges(o.host, { width: o.width }, true)),
      ];
      if (changes.length) view.dispatch({ changes, userEvent: 'input.resize' });
    };
    if (reader) {
      const drawn = reader
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
            attachMenuButton(el, menuAt, { edit: editSource, comment, copy: sourceText });
          },
        })
        .then((d) => {
          embedRenders.set(el, d);
          view.requestMeasure();
          caption();
          attachResizeHandle(view, el, resize);
          attachMenuButton(el, menuAt, { edit: editSource, comment, copy: sourceText });
        });
      holdRoom(el, known, drawn);
    }
    return el;
  }

  /** By the element: the widget that is asked may be a later one that took the element over. */
  override destroy(dom: HTMLElement): void {
    embedRenders.get(dom)?.dispose();
    embedRenders.delete(dom);
    embedMeasures.get(dom)?.disconnect();
    embedMeasures.delete(dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Where an embed that is drawn at `el` is written in the note: `![[…]]` with the attributes
 * behind it (`{width=50%}`), which are part of it.
 */
export function embedRange(view: EditorView, el: HTMLElement): { from: number; to: number } {
  const start = view.posAtDOM(el);
  const node = embedNodeAt(view, el);
  const line = view.state.doc.lineAt(start);
  if (!node) return { from: start, to: line.to };
  const media = mediaAt(line.text, node.from - line.from);
  return { from: node.from, to: media ? line.from + media.to : node.to };
}
/** The text of the embed that is drawn at `el`, to be written into another note. */
export function embedSource(view: EditorView, el: HTMLElement): string {
  const { from, to } = embedRange(view, el);
  return view.state.doc.sliceString(from, to);
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
    /** The caption of a frame is shown as text of the note, under it. */
    readonly captioned = false,
  ) {
    super();
  }

  override eq(other: BlockWidget): boolean {
    return (
      other.kind === this.kind &&
      other.source === this.source &&
      other.from === this.from &&
      other.label === this.label &&
      other.captioned === this.captioned &&
      other.epoch === this.epoch
    );
  }

  /** Made for reading or for writing (see `drawnFor`). */
  readonly epoch = drawnFor.epoch;

  /** A frame or a diagram is as high as it was when it was last on screen. */
  override get estimatedHeight(): number {
    return this.kind === 'code' ? (drawnHeights.get(this.source)?.height ?? -1) : -1;
  }

  override destroy(dom: HTMLElement): void {
    embedMeasures.get(dom)?.disconnect();
    embedMeasures.delete(dom);
  }

  /** The number is drawn by the style sheet from this (it can change while the block stays). */
  private applyLabel(dom: HTMLElement): void {
    dom.classList.toggle('has-text-caption', this.captioned);
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
    if (dom.dataset.epoch !== String(this.epoch)) return false;
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
    el.dataset.epoch = String(this.epoch);
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
      const drawn = () => {
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
            {
              copy: () => blockOf.get(el)!.source,
              edit: () => {
                // The cursor inside the block shows its source.
                const { source, from } = blockOf.get(el)!;
                view.dispatch({
                  selection: { anchor: Math.min(from + 4, from + source.length) },
                  effects: showSource.of({ from, to: from + source.length }),
                  scrollIntoView: true,
                });
                view.focus();
              },
              ...(deps.comment
                ? {
                    comment: () => {
                      const { source, from } = blockOf.get(el)!;
                      deps.comment!(view, { from, to: from + source.length });
                    },
                  }
                : {}),
              // Also over a block that could not be shown (a frame block with a mistake in
              // it): its source is reached through this button only.
              always: true,
            },
          );
        attach();
        menu();
        // A frame without a caption offers one (a caption is text of the note, under it).
        if (/^\s*(`{3,}|~{3,})\s*frame\b/.test(this.source) && !view.state.readOnly) {
          const offer = document.createElement('span');
          offer.className = 'cm-pm-caption is-empty cm-pm-frame-caption-offer';
          offer.textContent = 'Add a caption';
          offer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const { source, from } = blockOf.get(el)!;
            enterFrameCaption(view, { from, to: from + source.length });
          });
          el.append(offer);
        }
        // The frame itself appears a moment after the block.
        el.addEventListener('pumice-resize', () => {
          attach();
          if (!el.querySelector(':scope > .cm-pm-embed-menu')) menu();
        });
      };
      // Also when it could not be drawn at all: the buttons are how its source is reached.
      const rendered = deps.reader.render(el, this.source, {
        sourcePath: deps.sourcePath() ?? '',
      });
      holdRoom(el, heightAt(this.source, view.contentDOM.clientWidth), rendered);
      const measured = new ResizeObserver(() => {
        const now = blockOf.get(el);
        if (now && el.isConnected && el.offsetHeight > 0)
          drawnHeights.learn(now.source, {
            height: el.offsetHeight,
            width: view.contentDOM.clientWidth,
          });
      });
      measured.observe(el);
      embedMeasures.set(el, measured);
      void rendered.then(drawn, (e: unknown) => {
        el.textContent = `This block could not be shown: ${e instanceof Error ? e.message : String(e)}`;
        el.classList.add('cm-pm-block-failed');
        drawn();
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

  /** An embed is drawn as one element in place of its text. */
  const drawEmbed = (node: SyntaxNodeRef) => {
    const source = deps?.sourcePath();
    if (!sourceShownAt(state, node.from, node.to) && deps?.reader && source !== undefined) {
      const line = state.doc.lineAt(node.from);
      const media = mediaAt(line.text, node.from - line.from);
      // (An image by reference, `![alt][id]`, stays as it is written.)
      if (media?.from !== node.from - line.from) return;
      const end = line.from + media.to;
      const item = itemAt(state, node.from, 'fig', true);
      const label = item ? figureLabel(item) : undefined;
      const figure = isFigureTarget(media.target);
      const captionFrom = line.from + media.captionFrom;
      const captionTo = line.from + media.captionTo;
      // Its caption is the text of the note itself, where there is one (or one is begun).
      const written =
        figure &&
        hasCaptionPlace(media, line.text) &&
        (state.doc.sliceString(captionFrom, captionTo).trim() !== '' ||
          (!state.readOnly &&
            revealedAt(state, captionFrom, captionTo) &&
            state.selection.main.empty));
      // One element for the cursor (see `embedAtoms`), up to the caption.
      decorations.push(
        Decoration.replace({
          atom: true,
          widget: new EmbedWidget(
            media.target,
            media.subpath,
            media.alias,
            source,
            label,
            item?.id,
            written,
          ),
        }).range(node.from, written ? captionFrom : end),
      );
      if (figure) {
        const css = embedSizeProperties(media.size);
        const style = Object.entries(css)
          .flatMap(([name, value]) => (value ? [`${name}:${value}`] : []))
          .join(';');
        decorations.push(
          Decoration.mark({
            class: `cm-pm-figure pm-embed-box${css['--embed-w'] ? ' is-sized' : ''}`,
            ...(style ? { attributes: { style } } : {}),
            box: true,
            inclusive: true,
          }).range(node.from, end),
        );
      }
      if (written) {
        const attributes: Record<string, string> = label ? { 'data-label': `${label}: ` } : {};
        // (With what is hidden behind it, in whose place its label stands.)
        if (captionFrom < captionTo)
          decorations.push(
            Decoration.mark({
              class: 'cm-pm-caption is-text',
              attributes,
              box: true,
              inclusive: true,
            }).range(captionFrom, end),
          );
        else
          decorations.push(
            Decoration.widget({ widget: new EmptyCaptionWidget(label), side: 1 }).range(
              captionFrom,
            ),
          );
        decorations.push(
          Decoration.replace({
            atom: true,
            ...(item?.id && captionFrom < captionTo
              ? { widget: new LabelChipWidget(item.id, node.from) }
              : {}),
          }).range(captionTo, end),
        );
      }
      // The space between two embeds of a row is not drawn: text between the elements
      // of a row has no place on screen, and the cursor could not be kept there.
      const gap = /^[ \t]+(?=!\[)/.exec(state.doc.sliceString(end, state.doc.lineAt(end).to));
      if (gap && !sourceShownAt(state, end, end + gap[0].length + 3))
        hide(end, end + gap[0].length);
    }
  };

  // Embeds are drawn in the whole note, not only where it is on screen: the height of a
  // line that has been seen is kept only as long as what is drawn in it stays, and a note
  // whose pictures were forgotten as they left the screen changed its height with every
  // scroll (the scroll bar jumped).
  let covered = 0;
  const outside: { from: number; to: number }[] = [];
  for (const { from, to } of view.visibleRanges) {
    if (from > covered) outside.push({ from: covered, to: from });
    covered = Math.max(covered, to);
  }
  if (covered < state.doc.length) outside.push({ from: covered, to: state.doc.length });
  for (const { from, to } of outside)
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (!isEmbedNode(node.name)) return;
        // One that reaches into what is on screen is drawn there.
        if (node.from >= from && node.to <= to) drawEmbed(node);
        return false;
      },
    });

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
        if (isEmbedNode(name)) {
          drawEmbed(node);
          // (Its caption is drawn as other text is.)
          return undefined;
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
      const indent = /^[ \t]*/.exec(line.text)![0];
      if (indent.length === line.length) continue;
      const marker = /^(?:[-*+]|\d+[.)])[ \t]+/.exec(line.text.slice(indent.length))?.[0];
      if (!indent && !marker) continue;
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
      let steps = 0;
      let spare = 0;
      for (let i = 0; i < indent.length;) {
        // A step is a tab or two spaces; a single space left over is kept as it is.
        const length = indent[i] === '\t' ? 1 : indent[i + 1] === ' ' ? 2 : 1;
        if (indent[i] === '\t' || length === 2) {
          steps++;
          decorations.push(
            Decoration.mark({ class: 'cm-pm-indent' }).range(line.from + i, line.from + i + length),
          );
        } else {
          // Half a step: three spaces under `1. ` reach as far as the number does.
          spare++;
          decorations.push(
            Decoration.mark({ class: 'cm-pm-indent-half' }).range(line.from + i, line.from + i + 1),
          );
        }
        i += length;
      }
      // A long item wraps under its own text, not back at the edge of the page: the line hangs
      // by the width of everything in front of the text (the steps, and the marker).
      // A number takes half a step for each of its characters (`1. ` is three), whatever the
      // width of its digits: the text behind it, the rows it wraps to and a line set in by
      // hand under it (by as many spaces) all start at the same place.
      const numbered = marker && /^\d/.test(marker) ? marker.length : 0;
      if (numbered) {
        const at = line.from + indent.length;
        decorations.push(
          Decoration.mark({
            class: 'cm-pm-number',
            attributes: { style: `--pm-chars:${numbered}` },
          }).range(at, at + numbered),
        );
      }
      decorations.push(
        Decoration.line({
          class: 'cm-pm-hang',
          attributes: {
            style: `--pm-hang-steps:${steps + (marker && !numbered ? 1 : 0)};--pm-hang-chars:${spare + numbered}`,
          },
        }).range(line.from),
      );
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
          Decoration.replace({
            widget: new LabelWidget(item.caption ? `${figureLabel(item)}:` : figureLabel(item)),
          }).range(line.from + at, line.from + at + 'Table:'.length),
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

    /** Figures and their captions: around all that other extensions draw in them. */
    boxes: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.decorations = this.take(buildDecorations(view));
    }

    private take(all: DecorationSet): DecorationSet {
      const isBox = (deco: Decoration) => !!(deco.spec as { box?: boolean }).box;
      this.boxes = all.update({ filter: (_f, _t, deco) => isBox(deco) });
      const rest = all.update({ filter: (_f, _t, deco) => !isBox(deco) });
      this.atoms = atomsOf(rest);
      return rest;
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.readOnly !== update.state.readOnly ||
        update.startState.field(sourceShown, false) !== update.state.field(sourceShown, false) ||
        revealChanged(update.startState, update.state) ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        // Within a list item, whether the cursor is at the dash decides how it is drawn.
        (update.selectionSet &&
          [update.startState, update.state].some((s) =>
            /^\s*[-*+]\s/.test(s.doc.lineAt(s.selection.main.head).text),
          ))
      ) {
        this.decorations = this.take(buildDecorations(update.view));
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

/**
 * A figure inside a selection shows that it is selected, as text does (the selection is drawn
 * behind the text, where a picture covers it). Copying the selection copies its text.
 */
const embedSelection = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.mark(view);
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || update.viewportChanged)
        // After the editor has drawn what changed.
        update.view.requestMeasure({ key: this, read: () => this.mark(update.view) });
    }
    mark(view: EditorView) {
      const ranges = view.state.selection.ranges.filter((r) => !r.empty);
      for (const el of view.contentDOM.querySelectorAll<HTMLElement>('.cm-pm-embed')) {
        let selected = false;
        if (ranges.length && embedOf.has(el)) {
          const { from, to } = embedRange(view, el);
          selected = ranges.some((r) => r.from <= from && r.to >= to);
        }
        el.classList.toggle('is-selected', selected);
      }
    }
  },
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
      let isFrame = false;
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
        isFrame = lang === 'frame';
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
      const label =
        kind === 'math'
          ? ((item) => (item ? figureReference(item) : undefined))(itemAt(state, start, 'eq'))
          : kind === 'code'
            ? ((item) => (item ? figureLabel(item) : undefined))(itemAt(state, start, 'fig'))
            : undefined;
      const caption = isFrame ? frameCaption(state, { from: start, to: end }) : undefined;
      const written =
        caption &&
        (state.sliceDoc(caption.captionFrom, caption.captionTo).trim() !== '' ||
          (!state.readOnly && revealedAt(state, caption.captionFrom, caption.captionTo)));
      const captionLine = written ? state.doc.lineAt(caption.captionFrom) : undefined;
      // A rendered code block is one element for the cursor (see `mediaKeys`).
      const media = kind === 'code' ? { media: true, span: { from: start, to: end } } : {};
      decorations.push(
        Decoration.replace({
          ...media,
          widget: new BlockWidget(
            kind,
            state.doc.sliceString(start, end),
            start,
            label,
            !!captionLine,
          ),
          block: true,
        }).range(start, captionLine ? captionLine.from - 1 : end),
      );
      if (captionLine && caption) {
        // The caption of a frame: that line of the block, as the text under it.
        decorations.push(
          Decoration.line({
            class: 'cm-pm-caption cm-pm-caption-text-line',
            attributes: label ? { 'data-label': `${label}: ` } : {},
          }).range(captionLine.from),
          Decoration.replace({}).range(captionLine.from, caption.captionFrom),
        );
        if (caption.captionTo < captionLine.to)
          decorations.push(Decoration.replace({}).range(caption.captionTo, captionLine.to));
        if (caption.captionFrom === caption.captionTo)
          decorations.push(
            Decoration.widget({ widget: new EmptyCaptionWidget(undefined), side: 1 }).range(
              caption.captionFrom,
            ),
          );
        const id = itemAt(state, start, 'fig')?.id;
        if (id)
          decorations.push(
            Decoration.widget({ widget: new LabelChipWidget(id, start), side: 1 }).range(
              caption.captionTo,
            ),
          );
        for (const ref of referencesIn(state, caption))
          if (!revealedAt(state, ref.from, ref.to))
            decorations.push(
              Decoration.replace({ widget: new CaptionReferenceWidget(ref.text, ref.id) }).range(
                ref.from,
                ref.to,
              ),
            );
        if (captionLine.to < end)
          decorations.push(
            Decoration.replace({ ...media, block: true }).range(captionLine.to + 1, end),
          );
      }
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
    const spec = deco.spec as { media?: boolean; span?: Span };
    if (found || t <= f || !spec.media) return;
    found = spec.span ?? { from: f, to: t };
  });
  return found;
}

/** The drawn embeds on a line, in order. */
function embedsOn(view: EditorView, line: { from: number; to: number }): Span[] {
  const out: Span[] = [];
  view.plugin(inlinePreview)?.atoms.between(line.from, line.to, (f, t) => {
    // (Behind a caption is the rest of its figure.)
    if (out.some((e) => f >= e.from && t <= e.to)) return;
    const place = captionPlaces(view.state, f).find((p) => p.from === f);
    out.push({ from: f, to: Math.max(t, place?.to ?? t) });
  });
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
  const here = captionHere(state);
  if (here) {
    if (dir < 0 && head === here.captionFrom) return moveTo(view, here.from);
    if (dir > 0 && head === here.captionTo) return moveTo(view, here.to);
    return false;
  }
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
    const caption = captionOf(state, e);
    if (dir > 0 && (head >= e.from || at === e.from) && head < e.to)
      return moveTo(view, caption?.captionFrom ?? e.to);
    if (dir < 0 && (head <= e.to || at === e.to) && head > e.from)
      return moveTo(view, caption?.captionTo ?? e.from);
  }
  return false;
};

/**
 * Up and down: onto the line of an element, before it when the cursor comes from the start of
 * a line and after it otherwise; and on from an element to the line beyond it.
 */
const pastMedia =
  (dir: -1 | 1, captions = true) =>
  (view: EditorView) => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    // A figure's caption lies between the figure and the line under it.
    if (captions && captionStep(view, dir)) return true;
    const head = sel.head;
    const here = captionHere(state);
    if (here) {
      // Within a caption of several rows, the keys move within it.
      const next = view.moveVertically(sel, dir > 0).head;
      if (next !== head && next > here.captionFrom && next < here.captionTo) return false;
      if (dir < 0) return moveTo(view, here.from);
      const after = state.doc.lineAt(here.to).number + 1;
      if (after > state.doc.lines) return moveTo(view, here.to);
      const target = state.doc.line(after);
      return moveTo(view, blockMediaAt(state, target.from)?.from ?? target.from);
    }
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

/**
 * A click beside a line of media, left of its first element or right of its last, puts the
 * cursor at that end of the line (the browser would put it where the elements meet, or into a
 * caption).
 */
const clickBesideMedia = Prec.high(
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0 || e.shiftKey || e.detail > 1) return false;
      if ((e.target as HTMLElement).closest?.('.cm-pm-embed, .cm-pm-block')) return false;
      const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
      const line = view.state.doc.lineAt(block.from);
      if (!mediaOnly(view, line)) return false;
      const shown = embedsOn(view, line)
        .map((span) => mediaElement(view, span)?.getBoundingClientRect())
        .filter((r): r is DOMRect => !!r && r.width > 0);
      if (!shown.length) return false;
      const left = Math.min(...shown.map((r) => r.left));
      const right = Math.max(...shown.map((r) => r.right));
      // (A press in the margin comes as one at the text's left edge: see `MarkdownView`.)
      const at = e.clientX <= left + 2 ? line.from : e.clientX >= right - 2 ? line.to : undefined;
      if (at === undefined) return false;
      e.preventDefault();
      view.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' });
      view.focus();
      return true;
    },
  }),
);

export const livePreview: Extension = [
  clickBesideMedia,
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
  // (The lowest precedence is the outermost element.)
  Prec.lowest(
    EditorView.decorations.of((view) => view.plugin(inlinePreview)?.boxes ?? Decoration.none),
  ),
  captionEditing(sourceShownAt),
  embedSelection,
  embedDrag(embedRange),
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
