import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import {
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
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  citedKeys,
  editorCompletions,
  referenceLine,
  revealChanged,
  revealedLines,
  shortAuthors,
  type BibEntry,
  type BibliographyApi,
  type EditorExtensionContext,
} from '@pumice/api';
import { citeText, citedOf, inBrackets, referencesElement, type Cited } from './render';

export interface BibEditorDeps {
  bib: BibliographyApi;
  openUrl(url: string): void;
}

/** The bibliography changed (a file was read, a setting): what is drawn is drawn anew. */
const refresh = StateEffect.define<null>();

class CiteWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly key: string,
    readonly title: string,
  ) {
    super();
  }
  override eq(other: CiteWidget): boolean {
    return other.text === this.text && other.key === this.key && other.title === this.title;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-pm-cite';
    el.textContent = this.text;
    el.title = this.title;
    el.dataset.key = this.key;
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

class ReferencesWidget extends WidgetType {
  constructor(
    readonly cited: Cited,
    readonly open: (url: string) => void,
  ) {
    super();
  }
  private get signature(): string {
    return `${this.cited.style}\n${this.cited.list.map((e) => `${e.key}\t${referenceLine(e)}\t${e.url ?? ''}`).join('\n')}`;
  }
  override eq(other: ReferencesWidget): boolean {
    return other.signature === this.signature;
  }
  toDOM(): HTMLElement {
    const el = referencesElement(this.cited, this.open);
    el.classList.add('cm-pm-references');
    return el;
  }
  override get estimatedHeight(): number {
    return 60 + this.cited.list.length * 34;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

export function bibliographyExtension(deps: BibEditorDeps, ctx: EditorExtensionContext): Extension {
  const entriesOf = () => {
    const path = ctx.path();
    return path === undefined ? new Map<string, BibEntry>() : deps.bib.entries(path);
  };
  // What the note cites, once per version of its text and of the bibliography.
  let version = 0;
  const cache = new WeakMap<object, { version: number; cited: Cited }>();
  const citedIn = (state: EditorState): Cited => {
    const known = cache.get(state.doc);
    if (known?.version === version) return known.cited;
    const cited = citedOf(citedKeys(state.doc.toString()), entriesOf(), deps.bib.style());
    cache.set(state.doc, { version, cited });
    return cited;
  };

  const build = (view: EditorView): DecorationSet => {
    if (ctx.path() === undefined) return Decoration.none;
    const { state } = view;
    const entries = entriesOf();
    if (!entries.size) return Decoration.none;
    const live = !ctx.sourceMode();
    const active = revealedLines(state);
    const cited = citedIn(state);
    const deco: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from,
        to,
        enter: (node) => {
          if (node.name !== 'Citation') return;
          const key = state.doc.sliceString(node.from + 1, node.to);
          const entry = entries.get(key);
          if (!entry) return;
          const line = state.doc.lineAt(node.from);
          const title = referenceLine(entry);
          if (live && !active.has(line.number)) {
            const text = citeText(
              cited,
              entry,
              inBrackets(line.text.slice(0, node.from - line.from)),
            );
            deco.push(
              Decoration.replace({ widget: new CiteWidget(text, key, title) }).range(
                node.from,
                node.to,
              ),
            );
          } else
            deco.push(
              Decoration.mark({
                class: 'cm-pm-cite',
                attributes: { title, 'data-key': key },
              }).range(node.from, node.to),
            );
        },
      });
    }
    return Decoration.set(deco, true);
  };

  const citations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly sub: { dispose(): void };

      constructor(readonly view: EditorView) {
        this.decorations = build(view);
        this.sub = deps.bib.onDidChange(() => {
          version++;
          // (Not while the editor is being updated.)
          queueMicrotask(() => this.view.dispatch({ effects: refresh.of(null) }));
        });
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          revealChanged(u.startState, u.state) ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))
        )
          this.decorations = build(u.view);
      }
      destroy() {
        this.sub.dispose();
      }
    },
    { decorations: (v) => v.decorations },
  );

  /** The list of references, under the last line of the note. */
  const listOf = (state: EditorState): DecorationSet => {
    if (ctx.path() === undefined || ctx.sourceMode()) return Decoration.none;
    const cited = citedIn(state);
    if (!cited.list.length) return Decoration.none;
    return Decoration.set([
      Decoration.widget({
        widget: new ReferencesWidget(cited, deps.openUrl),
        block: true,
        side: 1,
      }).range(state.doc.length),
    ]);
  };
  const references = StateField.define<DecorationSet>({
    create: listOf,
    update: (value, tr) =>
      tr.docChanged || tr.effects.some((e) => e.is(refresh)) ? listOf(tr.state) : value,
    provide: (field) => EditorView.decorations.from(field),
  });

  /** A click on a citation that is drawn goes to its entry in the list. */
  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.cm-pm-cite');
      if (!el || e.button !== 0) return false;
      const drawn = el.contentEditable === 'false' || !!el.closest('[contenteditable=false]');
      if (!drawn && !(e.metaKey || e.ctrlKey)) return false;
      const key = el.dataset.key;
      if (!key) return false;
      e.preventDefault();
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }),
      });
      const show = (tries: number) =>
        setTimeout(() => {
          const item = [...view.dom.querySelectorAll<HTMLElement>('.cm-pm-references li')].find(
            (li) => li.dataset.key === key,
          );
          if (!item) return tries > 1 ? void show(tries - 1) : undefined;
          item.scrollIntoView({ block: 'nearest' });
          item.classList.remove('pm-flash');
          void item.offsetWidth;
          item.classList.add('pm-flash');
          setTimeout(() => item.classList.remove('pm-flash'), 1400);
        }, 120);
      show(4);
      return true;
    },
  });

  /** After `@`: the entries of the bibliography, by key, author, year or title. */
  const complete = (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/@[A-Za-z0-9_:.+/-]*$/);
    if (!before) return null;
    const prev = context.state.doc.sliceString(Math.max(0, before.from - 1), before.from);
    if (/[A-Za-z0-9@]/.test(prev)) return null;
    const entries = entriesOf();
    if (!entries.size) return null;
    const words = before.text.slice(1).toLowerCase().split(/\s+/).filter(Boolean);
    const options: Completion[] = [];
    for (const entry of entries.values()) {
      const who = shortAuthors(entry);
      const hay =
        `${entry.key} ${entry.authors.map((a) => a.family).join(' ')} ${entry.year ?? ''} ${entry.title ?? ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const starts = words.length > 0 && entry.key.toLowerCase().startsWith(words[0]!);
      options.push({
        label: `@${entry.key}`,
        detail: `${who}${entry.year ? ` ${entry.year}` : ''}${entry.title ? ` · ${entry.title}` : ''}`,
        boost: starts ? 20 : 0,
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
          // A space behind it, to go on writing (not before what closes a bracket).
          const next = view.state.doc.sliceString(to, to + 1);
          const text = `@${entry.key}${/[ \t.,;:!?)\]}]/.test(next) ? '' : ' '}`;
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
            userEvent: 'input.complete',
          });
        },
      });
      if (options.length >= 60) break;
    }
    if (!options.length) return null;
    return { from: before.from, to: context.pos, options, filter: false };
  };

  return [citations, references, clicks, editorCompletions.of(complete)];
}
