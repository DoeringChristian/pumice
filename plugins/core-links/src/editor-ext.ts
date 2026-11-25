import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import {
  Annotation,
  EditorState,
  Transaction,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  editorCompletions,
  parseWikiLinkContent,
  revealChanged,
  revealedAt,
  type EditorExtensionContext,
  type LinksApi,
  type MetadataIndexApi,
  type VaultPath,
  type WorkspaceApi,
} from '@pumice/api';

import {
  followLabelEdits,
  localReference,
  numberedReferences,
  referenceCompletion,
} from './references';

export interface LinkEditorDeps {
  links: LinksApi;
  index: MetadataIndexApi;
  workspace: WorkspaceApi;
}

interface WikiLinkInfo {
  from: number;
  to: number;
  target: string;
  subpath?: string;
  alias?: string;
  /** `[[`+target(+subpath)+`|` range, folded when the target is an ID. */
  idFrom: number;
  idTo: number;
  aliasFrom: number;
  aliasTo: number;
}

function readLink(
  state: EditorState,
  node: {
    from: number;
    to: number;
    node: { getChild(name: string): { from: number; to: number } | null };
  },
): WikiLinkInfo {
  const content = state.doc.sliceString(node.from + 2, node.to - 2);
  const parts = parseWikiLinkContent(content);
  const pipe = node.node.getChild('WikiLinkPipe');
  const alias = node.node.getChild('WikiLinkAlias');
  const info: WikiLinkInfo = {
    from: node.from,
    to: node.to,
    target: parts.target,
    idFrom: node.from + 2,
    idTo: pipe ? pipe.to : node.to - 2,
    aliasFrom: alias?.from ?? node.to - 2,
    aliasTo: alias?.to ?? node.to - 2,
  };
  if (parts.subpath) info.subpath = parts.subpath;
  if (parts.alias !== undefined) info.alias = parts.alias;
  return info;
}

class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly resolved: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  override eq(other: LinkWidget): boolean {
    return (
      other.text === this.text &&
      other.resolved === this.resolved &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  toDOM(): HTMLElement {
    const a = document.createElement('span');
    a.className = `cm-pm-wikilink${this.resolved ? '' : ' is-unresolved'}`;
    a.textContent = this.text;
    a.dataset.linkFrom = String(this.from);
    a.dataset.linkTo = String(this.to);
    return a;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function linkDecorations(deps: LinkEditorDeps, ctx: EditorExtensionContext): Extension {
  const build = (view: EditorView): { decorations: DecorationSet; atomic: DecorationSet } => {
    const source = ctx.path();
    const live = !ctx.sourceMode();
    // Only the link the cursor is in or at shows as written; the rest of its line stays drawn.
    const at = (from: number, to: number) => revealedAt(view.state, from, to);
    const deco: Range<Decoration>[] = [];
    const atomic: Range<Decoration>[] = [];
    if (source === undefined) return { decorations: Decoration.none, atomic: Decoration.none };
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          if (node.name === 'Reference') {
            // `@fig-loss` reads as what it means ("Figure 2") where it is not being written.
            const id = view.state.doc.sliceString(node.from + 1, node.to);
            const text = localReference(view.state, id);
            const attributes = {
              class: `cm-pm-wikilink${text ? '' : ' is-unresolved'}`,
              'data-link-from': String(node.from),
              'data-link-to': String(node.to),
            };
            if (live && text && !at(node.from, node.to))
              deco.push(
                Decoration.replace({
                  widget: new LinkWidget(text, true, node.from, node.to),
                }).range(node.from, node.to),
              );
            else deco.push(Decoration.mark({ attributes }).range(node.from, node.to));
            return false;
          }
          if (node.name !== 'WikiLink') return undefined;
          const link = readLink(view.state, node);
          const resolved = deps.index.resolve(link.target, source);
          const lineActive = at(link.from, link.to);
          const attrs = {
            class: `cm-pm-wikilink${resolved || !link.target ? '' : ' is-unresolved'}`,
            'data-link-from': String(link.from),
            'data-link-to': String(link.to),
          };
          if (live && !lineActive) {
            if (link.alias) {
              deco.push(Decoration.replace({}).range(link.from, link.aliasFrom));
              deco.push(Decoration.mark({ attributes: attrs }).range(link.aliasFrom, link.aliasTo));
              deco.push(Decoration.replace({}).range(link.aliasTo, link.to));
            } else {
              // A label of this note reads as it is numbered right now (the index may lag).
              const text =
                (!link.target && link.subpath?.startsWith('^')
                  ? localReference(view.state, link.subpath.slice(1))
                  : undefined) ?? deps.links.displayText(link, source);
              const widget = Decoration.replace({
                widget: new LinkWidget(text, !!resolved || !link.target, link.from, link.to),
              });
              deco.push(widget.range(link.from, link.to));
            }
            return false;
          }
          // Editing (or source mode): show the syntax.
          if (link.aliasFrom < link.aliasTo)
            deco.push(Decoration.mark({ attributes: attrs }).range(link.aliasFrom, link.aliasTo));
          else if (link.idTo > link.idFrom) {
            deco.push(Decoration.mark({ attributes: attrs }).range(link.idFrom, link.idTo));
          }
          return false;
        },
      });
    }
    return { decorations: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
  };

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;
      private readonly sub: { dispose(): void };

      constructor(readonly view: EditorView) {
        ({ decorations: this.decorations, atomic: this.atomic } = build(view));
        // Titles and resolution change when other notes change.
        this.sub = deps.index.onDidChange(() => {
          ({ decorations: this.decorations, atomic: this.atomic } = build(this.view));
          this.view.dispatch({});
        });
      }

      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          revealChanged(u.startState, u.state) ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          ({ decorations: this.decorations, atomic: this.atomic } = build(u.view));
        }
      }

      destroy() {
        this.sub.dispose();
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) =>
        EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
    },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.cm-pm-wikilink');
      if (!el || e.button !== 0) return false;
      // Rendered links (widgets, or link text on a line not being edited) open on click;
      // editable link text needs Mod.
      const widget =
        el.contentEditable === 'false' || el.closest('[contenteditable=false]') !== null;
      const from = Number(el.dataset.linkFrom);
      const to = Number(el.dataset.linkTo);
      const editing =
        view.hasFocus && view.state.selection.ranges.some((r) => r.from <= to && r.to >= from);
      const rendered = widget || (!ctx.sourceMode() && !editing);
      if (!rendered && !(e.metaKey || e.ctrlKey)) return false;
      const source = ctx.path();
      if (Number.isNaN(from) || source === undefined) return false;
      e.preventDefault();
      const raw = view.state.doc.sliceString(from, to);
      const parts = raw.startsWith('@')
        ? { target: '', subpath: `^${raw.slice(1)}` }
        : parseWikiLinkContent(raw.slice(2, -2));
      void deps.links.openLink(parts.target, {
        sourcePath: source,
        newTab: e.shiftKey || ((e.metaKey || e.ctrlKey) && e.altKey),
        ...(parts.subpath ? { subpath: parts.subpath } : {}),
      });
      return true;
    },
  });

  return [plugin, clicks];
}

function linkCompletion(deps: LinkEditorDeps, ctx: EditorExtensionContext): Extension {
  const source = (context: CompletionContext): CompletionResult | null => {
    const path = ctx.path();
    if (path === undefined) return null;
    const before = context.matchBefore(/!?\[\[[^[\]\n]*$/);
    if (!before) return null;
    const embed = before.text.startsWith('!');
    const query = before.text.slice(embed ? 3 : 2);
    // Behind the bar of an embed its caption is written, not its target.
    if (embed && query.includes('|')) return null;
    const line = context.state.doc.lineAt(context.pos);
    const inTable = /^\s*\|/.test(line.text);
    // Swallow the `]]` auto-inserted by bracket closing.
    const after = context.state.doc.sliceString(context.pos, context.pos + 2);
    const to = context.pos + (after === ']]' ? 2 : after.startsWith(']') ? 1 : 0);
    const suggestions = deps.links.suggest(query.replace(/\\?\|.*$/, ''), path);
    const options: Completion[] = suggestions.map((s, i) => ({
      label: s.label,
      detail: s.detail ?? '',
      boost: -i / 100,
      apply: (view: EditorView, _c: Completion, from: number) => {
        const text = s.insert({ embed, inTable });
        view.dispatch({
          changes: { from: from - (embed ? 3 : 2), to, insert: text },
          selection: { anchor: from - (embed ? 3 : 2) + text.length },
          userEvent: 'input.complete',
        });
      },
    }));
    return { from: before.from + (embed ? 3 : 2), to: context.pos, options, filter: false };
  };
  return editorCompletions.of(source);
}

export function linkEditorExtension(deps: LinkEditorDeps, ctx: EditorExtensionContext): Extension {
  return [
    linkDecorations(deps, ctx),
    referenceCompletion(),
    linkCompletion(deps, ctx),
    numberedReferences(),
    followLabelEdits(),
  ];
}

export type { VaultPath };
