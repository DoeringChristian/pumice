import { syntaxTree } from '@codemirror/language';
import type { TreeCursor } from '@lezer/common';
import { Facet, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
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
} from '@pumice/api';
import { calloutStyle, createIcon } from '@pumice/ui';

/** Services the preview widgets use; provided per editor. */
export interface PreviewDeps {
  syntax: MarkdownSyntaxApi;
  reader?: ReaderApi;
  sourcePath(): VaultPath | undefined;
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

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly from: number,
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
      view.dispatch({ selection: { anchor: this.from + (this.display ? 3 : 1) } });
      view.focus();
    });
    return el;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class EmbedWidget extends WidgetType {
  private disposable: { dispose(): void } | undefined;

  constructor(
    readonly target: string,
    readonly subpath: string | undefined,
    readonly alias: string | undefined,
    readonly sourcePath: string,
  ) {
    super();
  }

  override eq(other: EmbedWidget): boolean {
    return (
      other.target === this.target &&
      other.subpath === this.subpath &&
      other.alias === this.alias &&
      other.sourcePath === this.sourcePath
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-pm-embed';
    const reader = view.state.facet(previewDeps)?.reader;
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
          onDidRender: () => view.requestMeasure(),
        })
        .then((d) => {
          this.disposable = d;
          view.requestMeasure();
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
class BlockWidget extends WidgetType {
  constructor(
    readonly kind: 'table' | 'math' | 'properties' | 'code',
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }

  override eq(other: BlockWidget): boolean {
    return other.kind === this.kind && other.source === this.source && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const deps = view.state.facet(previewDeps);
    const el = document.createElement('div');
    el.className = `cm-pm-block cm-pm-block-${this.kind}`;
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
      void deps.reader.render(el, this.source, { sourcePath: deps.sourcePath() ?? '' });
    }
    el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a') && (e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      view.dispatch({
        selection: {
          anchor:
            this.kind === 'properties' ? Math.min(4, this.from + this.source.length) : this.from,
        },
      });
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
          if (name === 'Comment' || name === 'Tag' || name === 'BlockId') return false;
          return;
        }
        if (HIDDEN_MARKS.has(name)) {
          if (node.node.parent?.name !== 'FencedCode' && !isActive(node.from))
            hide(node.from, node.to);
          return;
        }
        if (name === 'InlineMath' || name === 'InlineMathDisplay') {
          if (!rangeActive(node.from, node.to) && deps?.reader) {
            const mark = name === 'InlineMath' ? 1 : 2;
            const tex = state.doc.sliceString(node.from + mark, node.to - mark);
            decorations.push(
              Decoration.replace({ widget: new MathWidget(tex, false, node.from) }).range(
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
          if (!isActive(node.from)) {
            decorations.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
            );
          }
          return;
        }
      },
    });
  }
  return Decoration.set(decorations, true);
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
        syntaxTree(update.startState) !== syntaxTree(update.state)
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
      if (!kind || owned.has(name) || touches(from, to)) continue;
      // Block replacements must cover whole lines.
      const start = state.doc.lineAt(from).from;
      const end = state.doc.lineAt(to).to;
      decorations.push(
        Decoration.replace({
          widget: new BlockWidget(kind, state.doc.sliceString(start, end), start),
          block: true,
        }).range(start, end),
      );
    } while (cursor.nextSibling());
  };
  visit(syntaxTree(state).topNode.cursor());
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

export const livePreview: Extension = [revealTracking, inlinePreview, blockPreview, remeasure];

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
