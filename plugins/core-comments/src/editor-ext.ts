import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { EditorExtensionContext, VaultPath } from '@pumice/api';
import type { CommentStore } from './store';

interface Mark {
  id: string;
  from: number;
  to: number;
  resolved: boolean;
}

/** Replaces the comment ranges shown in the editor. */
const setMarks = StateEffect.define<Mark[]>();
/** Highlights one thread (the one selected in the panel), or none. */
export const setActiveThread = StateEffect.define<string | null>();

interface MarkState {
  marks: Mark[];
  active: string | null;
}

const markField = StateField.define<MarkState>({
  create: () => ({ marks: [], active: null }),
  update(value, tr) {
    let { marks, active } = value;
    if (tr.docChanged) {
      marks = marks
        .map((m) => ({ ...m, from: tr.changes.mapPos(m.from, 1), to: tr.changes.mapPos(m.to, -1) }))
        .map((m) => (m.to < m.from ? { ...m, to: m.from } : m));
    }
    for (const e of tr.effects) {
      if (e.is(setMarks)) marks = e.value;
      if (e.is(setActiveThread)) active = e.value;
    }
    return marks === value.marks && active === value.active ? value : { marks, active };
  },
  provide: (f) =>
    EditorView.decorations.from(f, ({ marks, active }) => {
      const out: Range<Decoration>[] = [];
      for (const m of marks) {
        if (m.resolved && m.id !== active) continue;
        const cls = `pm-comment-mark${m.id === active ? ' is-active' : ''}`;
        const attrs = { class: cls, 'data-thread': m.id };
        if (m.to > m.from) out.push(Decoration.mark({ attributes: attrs }).range(m.from, m.to));
        // (Text that was deleted leaves no mark: its comment is in the panel.)
      }
      return Decoration.set(out, true);
    }),
});

/** Current comment ranges of an editor (for the panel and saving anchors). */
export function commentRanges(view: EditorView): Map<string, { from: number; to: number }> {
  return new Map(view.state.field(markField, false)?.marks.map((m) => [m.id, m]) ?? []);
}

export interface CommentEditorDeps {
  store: CommentStore;
  /** Clicking commented text: show the thread in the panel. */
  onClickThread(path: VaultPath, threadId: string): void;
}

export function commentEditorExtension(
  deps: CommentEditorDeps,
  ctx: EditorExtensionContext,
): Extension {
  const sync = ViewPlugin.fromClass(
    class {
      private sub: { dispose(): void };
      private saveTimer: ReturnType<typeof setTimeout> | undefined;
      private loading = 0;
      /** Whether the note has comments at all (also ones without their text). */
      private any = false;

      constructor(readonly view: EditorView) {
        this.sub = deps.store.onDidChange((path) => {
          if (path === ctx.path()) void this.reload();
        });
        void this.reload();
      }

      async reload() {
        const path = ctx.path();
        if (path === undefined) return;
        const gen = ++this.loading;
        const threads = await deps.store.threads(path);
        if (gen !== this.loading || ctx.path() !== path) return;
        this.any = threads.length > 0;
        const len = this.view.state.doc.length;
        const marks: Mark[] = threads
          .filter((t) => t.range)
          .map((t) => ({
            id: t.id,
            from: Math.min(t.range!.from, len),
            to: Math.min(t.range!.to, len),
            resolved: t.resolved,
          }));
        this.view.dispatch({ effects: setMarks.of(marks) });
      }

      update(u: { docChanged: boolean; view: EditorView }) {
        if (!u.docChanged || !this.any) return;
        // Save where the threads moved to, once typing pauses.
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
          const path = ctx.path();
          if (path === undefined) return;
          void deps.store.updateRanges(
            path,
            commentRanges(this.view),
            this.view.state.doc.toString(),
          );
        }, 1500);
      }

      destroy() {
        clearTimeout(this.saveTimer);
        this.sub.dispose();
      }
    },
  );

  const clicks = EditorView.domEventHandlers({
    click(e) {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-thread]');
      const path = ctx.path();
      if (!el || path === undefined) return false;
      deps.onClickThread(path, el.dataset.thread!);
      return false;
    },
  });

  return [markField, sync, clicks];
}

export { markField };
