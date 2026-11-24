import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indentLess, indentMore } from '@codemirror/commands';
import { yUndoManagerKeymap } from 'y-codemirror.next';

// The Yjs-aware undo/redo commands are only exported through their keymap.
const undo = (v: EditorView) => yUndoManagerKeymap.find((k) => k.key === 'Mod-z')?.run?.(v);
const redo = (v: EditorView) => yUndoManagerKeymap.find((k) => k.key === 'Mod-y')?.run?.(v);
import {
  DisposableStore,
  Documents,
  Editor,
  MarkdownSyntax,
  MetadataIndex,
  Links,
  Reader,
  SettingsUi,
  ShellService,
  Vault,
  Workspace,
  definePlugin,
  type EditorApi,
  type EditorContextMenuItem,
  type MenuEntry,
  type VaultPath,
  type EditorToolbarAction,
  type EditorExtensionContext,
  type PluginModule,
} from '@pumice/api';
import { h, settingItem, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { embedAt } from './resize';
import './editor.css';
import { MarkdownView } from './markdown-view';
import { captionStep, editCaptionAtCursor, embedSource, shownCaptions } from './live-preview';
import { TextView } from './text-view';
import { HEADING_PREFIX, linePrefixChange, TASK_PREFIX, type LinePrefix } from './toolbar';

export { MarkdownView } from './markdown-view';

export const manifest = manifestJson;

/** Wraps the selection in `marker` or removes it if already wrapped. */
/** What stands in front of the text of a line: its indentation, `>`, a list marker, a box, `#`. */
const LINE_PREFIX =
  /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:#{1,6}[ \t]+)?/;

/**
 * The parts of a selection that a mark (`**`, `==`) goes around: the text of each line by
 * itself, without what stands in front of it and without the spaces at its ends. A mark
 * around a list marker or across the end of a line would not be one (and `==` alone on a
 * line makes a heading of the line above).
 */
export function wrapParts(
  doc: { lineAt(pos: number): { from: number; to: number; text: string; number: number } },
  from: number,
  to: number,
): Array<{ from: number; to: number }> {
  const parts: Array<{ from: number; to: number }> = [];
  for (let pos = from; pos <= to;) {
    const line = doc.lineAt(pos);
    let a = Math.max(from, line.from + LINE_PREFIX.exec(line.text)![0].length);
    let b = Math.min(to, line.to);
    while (a < b && /\s/.test(line.text[a - line.from]!)) a++;
    while (b > a && /\s/.test(line.text[b - 1 - line.from]!)) b--;
    if (a < b) parts.push({ from: a, to: b });
    pos = line.to + 1;
  }
  return parts;
}

function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const n = marker.length;
  view.dispatch(
    state.changeByRange((range) => {
      if (range.empty) {
        // Nothing selected: the marks, with the cursor between them (or out of them again).
        const before = state.sliceDoc(range.from - n, range.from);
        const after = state.sliceDoc(range.to, range.to + n);
        if (before === marker && after === marker)
          return {
            changes: { from: range.from - n, to: range.to + n },
            range: EditorSelection.cursor(range.from - n),
          };
        return {
          changes: { from: range.from, insert: marker + marker },
          range: EditorSelection.cursor(range.from + n),
        };
      }
      const parts = wrapParts(state.doc, range.from, range.to);
      if (!parts.length) return { range };
      // Marked already, with the marks around the part or as its ends.
      const outside = (p: { from: number; to: number }) =>
        state.sliceDoc(p.from - n, p.from) === marker && state.sliceDoc(p.to, p.to + n) === marker;
      const inside = (p: { from: number; to: number }) =>
        p.to - p.from >= 2 * n &&
        state.sliceDoc(p.from, p.from + n) === marker &&
        state.sliceDoc(p.to - n, p.to) === marker;
      const marked = parts.every((p) => outside(p) || inside(p));
      const changes = parts.flatMap((p): Array<{ from: number; to?: number; insert?: string }> =>
        marked
          ? outside(p)
            ? [
                { from: p.from - n, to: p.from },
                { from: p.to, to: p.to + n },
              ]
            : [
                { from: p.from, to: p.from + n },
                { from: p.to - n, to: p.to },
              ]
          : outside(p) || inside(p)
            ? []
            : [
                { from: p.from, insert: marker },
                { from: p.to, insert: marker },
              ],
      );
      const mapped = state.changes(changes);
      return {
        changes,
        range: EditorSelection.range(
          mapped.mapPos(parts[0]!.from, 1),
          mapped.mapPos(parts[parts.length - 1]!.to, -1),
        ),
      };
    }),
  );
  return true;
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const documents = ctx.use(Documents);
    const vault = ctx.use(Vault);
    const shell = ctx.use(ShellService);
    const syntax = ctx.use(MarkdownSyntax);

    const views = new Set<MarkdownView>();
    const toolbarActions: EditorToolbarAction[] = [];
    const menuItems: EditorContextMenuItem[] = [];
    const factories: ((c: EditorExtensionContext) => Extension)[] = [];
    const fieldFactories: (() => Extension)[] = [];
    const captionFactories: ((note: EditorView) => Extension)[] = [];
    let active: MarkdownView | undefined;
    let sourceMode = ctx.settings.get('sourceMode', false);

    /** Source or drawn, for every note that is open (and those opened later). */
    const setSourceMode = (on: boolean) => {
      if (on === sourceMode) return;
      sourceMode = on;
      void ctx.settings.set('sourceMode', sourceMode);
      for (const v of views) {
        v.setSourceMode(sourceMode);
        v.reconfigureContributed();
      }
    };

    const words = workspace.addStatusBarItem(10);
    ctx.register(words);
    const updateStatus = () => {
      const view = active && workspace.activeFile === active.path ? active : undefined;
      words.setText(view ? `${view.wordCount().toLocaleString()} words` : '');
    };
    ctx.register(
      workspace.onDidChangeActiveFile(() => {
        active = [...views].find((v) => v.path === workspace.activeFile);
        updateStatus();
      }),
    );

    ctx.register(
      workspace.registerView({
        type: 'markdown',
        title: 'Markdown',
        icon: 'file-text',
        create: async (viewCtx, state) => {
          let view: MarkdownView | undefined;
          view = new MarkdownView(
            viewCtx,
            {
              workspace,
              documents,
              vault,
              syntax,
              reader: () => ctx.tryUse(Reader),
              index: () => ctx.tryUse(MetadataIndex),
              contributed: () =>
                factories.map((f) => f({ path: () => view?.path, sourceMode: () => sourceMode })),
              fieldExtensions: () => fieldFactories.map((f) => f()),
              captionExtensions: (note) => captionFactories.map((f) => f(note)),
              sourceMode: () => sourceMode,
              setSourceMode: (on) => setSourceMode(on),
              closeLeft: () => ctx.settings.get('closeLeft', true),
              // Through the command, so the editor does not depend on the comments plugin.
              comment: (_v, range) =>
                void ctx.commands
                  .execute('comments.add', { ...range, media: true })
                  .catch(() => undefined),
              openExternal: (url) => void shell.openExternal(url),
              links: () => ctx.tryUse(Links),
              run: (command, arg) => void ctx.commands.execute(command, arg).catch(() => undefined),
              embedMenu: (v, host, path, at) => showEmbedMenu(v, host, path, at),
              blockMenu: (v, block, at) => showBlockMenu(v, block, at),
              toolbarActions: () =>
                [...toolbarActions].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
              touch: () =>
                workspace.layout !== 'desktop' || matchMedia('(pointer: coarse)').matches,
              onActiveChange: (v) => {
                active = v ?? [...views].find((x) => x.path === workspace.activeFile);
                updateStatus();
              },
            },
            () => new DisposableStore(),
          );
          views.add(view);
          const dispose = view.dispose.bind(view);
          view.dispose = () => {
            views.delete(view!);
            dispose();
          };
          await view.setState(state);
          return view;
        },
      }),
    );
    ctx.register(
      workspace.registerFileHandler({
        viewType: 'markdown',
        extensions: ['md', 'markdown'],
      }),
    );
    // Any other file that holds text opens as plain text: when nothing else opens its type,
    // or when it is chosen ("Open with…").
    ctx.register(
      workspace.registerView({
        type: 'text',
        title: 'Text',
        icon: 'file-text',
        async create(view, state) {
          const text = new TextView(view, { documents, workspace });
          await text.setState(state);
          return text;
        },
      }),
    );
    ctx.register(
      workspace.registerFileHandler({
        viewType: 'text',
        title: 'Plain text',
        extensions: ['*'],
        optional: true,
      }),
    );

    const activeView = () => (active && workspace.activeFile === active.path ? active : undefined);
    const activeEditor = () => {
      const view = activeView();
      return view && !view.isReading ? view : undefined;
    };
    const editorApi: EditorApi = {
      registerToolbarAction(action) {
        toolbarActions.push(action);
        return { dispose: () => toolbarActions.splice(toolbarActions.indexOf(action) >>> 0, 1) };
      },
      registerContextMenuItem(item) {
        menuItems.push(item);
        return { dispose: () => menuItems.splice(menuItems.indexOf(item) >>> 0, 1) };
      },
      active() {
        const view = activeEditor();
        return view?.path !== undefined ? { path: view.path, view: view.editor } : undefined;
      },
      insertAtCursor(text) {
        const view = activeEditor()?.editor;
        if (!view) return false;
        view.dispatch(view.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: 'input.paste',
        });
        view.focus();
        return true;
      },
      registerCaptionExtension(factory) {
        captionFactories.push(factory);
        return {
          dispose: () => void captionFactories.splice(captionFactories.indexOf(factory) >>> 0, 1),
        };
      },
      registerFieldExtension(factory) {
        fieldFactories.push(factory);
        return {
          dispose: () => void fieldFactories.splice(fieldFactories.indexOf(factory) >>> 0, 1),
        };
      },
      enterCaptionFrom: (view, dir) =>
        captionStep(view, dir) ||
        (dir < 0 && ([...views].find((v) => v.editor === view)?.enterTitle() ?? false)),
      captions: (view) => shownCaptions(view),
      registerExtension(factory) {
        factories.push(factory);
        for (const v of views) v.reconfigureContributed();
        return {
          dispose: () => {
            factories.splice(factories.indexOf(factory) >>> 0, 1);
            for (const v of views) v.reconfigureContributed();
          },
        };
      },
    };
    ctx.provide(Editor, editorApi);

    // Right-click menu: clipboard items plus whatever plugins registered.
    const clipboardItems: EditorContextMenuItem[] = [
      {
        id: 'cut',
        label: 'Cut',
        order: 0,
        when: (v) => !v.state.selection.main.empty && !v.state.readOnly,
        run: async (v) => {
          const { from, to } = v.state.selection.main;
          await navigator.clipboard.writeText(v.state.sliceDoc(from, to));
          v.dispatch({ changes: { from, to }, userEvent: 'delete.cut' });
        },
      },
      {
        id: 'copy',
        label: 'Copy',
        order: 1,
        when: (v) => !v.state.selection.main.empty,
        run: (v) => {
          const { from, to } = v.state.selection.main;
          return navigator.clipboard.writeText(v.state.sliceDoc(from, to));
        },
      },
      {
        id: 'paste',
        label: 'Paste',
        order: 2,
        when: (v) => !v.state.readOnly,
        run: async (v) => {
          const text = await navigator.clipboard.readText();
          v.dispatch(v.state.replaceSelection(text), { userEvent: 'input.paste' });
        },
      },
    ];
    /** Referring to a figure from its menu (the links plugin does it, where it is there). */
    const referenceEntries = (pos: () => number): MenuEntry[] => [
      {
        label: 'Copy reference',
        icon: 'link',
        run: () =>
          ctx.commands.execute('links.copy-reference', { pos: pos() }).catch(() => undefined),
      },
      {
        label: 'Rename label…',
        icon: 'pencil',
        run: () =>
          ctx.commands.execute('links.rename-label', { pos: pos() }).catch(() => undefined),
      },
    ];
    /** Edit or remove a rendered block (a frame block). */
    const showBlockMenu = (
      view: EditorView,
      block: { from: number; to: number },
      at: { x: number; y: number },
    ) => {
      const entries: MenuEntry[] = [
        {
          label: 'Edit the block',
          icon: 'pencil',
          run: () => {
            // The cursor inside shows the block's source.
            view.dispatch({ selection: { anchor: Math.min(block.from + 4, block.to) } });
            view.focus();
          },
        },
        {
          label: 'Copy as text',
          icon: 'copy',
          run: () => navigator.clipboard.writeText(view.state.sliceDoc(block.from, block.to)),
        },
        ...(view.state.readOnly ? [] : referenceEntries(() => block.from)),
        ...(view.state.readOnly
          ? []
          : [
              {
                label: 'Remove from note…',
                icon: 'x',
                danger: true,
                run: async () => {
                  const ok = await workspace.confirm(
                    'Remove this block from the note? The frame and its files stay in the vault.',
                    { confirmLabel: 'Remove' },
                  );
                  if (!ok) return;
                  const { doc } = view.state;
                  // With the line break after it.
                  const to = block.to < doc.length ? block.to + 1 : block.to;
                  view.dispatch({ changes: { from: block.from, to }, userEvent: 'delete' });
                },
              },
            ]),
      ];
      workspace.showContextMenu(entries, at);
    };

    /** Open, copy, or remove from the note an embedded picture, video or frame. */
    const showEmbedMenu = (
      view: EditorView,
      host: HTMLElement,
      notePath: VaultPath,
      at: { x: number; y: number },
    ) => {
      const where = () => {
        const line = view.state.doc.lineAt(view.posAtDOM(host));
        const found = embedAt(line.text, view.posAtDOM(host) - line.from);
        return found && { line, ...found };
      };
      const first = where();
      if (!first) return;
      const index = ctx.tryUse(MetadataIndex);
      const file =
        index?.resolve(first.target, notePath)?.file.path ??
        (vault.get(first.target)?.kind === 'file' ? first.target : undefined);
      const name = (file ?? first.target).split('/').pop() ?? first.target;
      const removeFromNote = () => {
        const now = where();
        if (!now) return;
        // A line that held nothing else goes with it.
        const rest = now.line.text.slice(0, now.from) + now.line.text.slice(now.to);
        const whole = !rest.trim() && now.line.to < view.state.doc.length;
        view.dispatch({
          changes: whole
            ? { from: now.line.from, to: now.line.to + 1 }
            : { from: now.line.from + now.from, to: now.line.from + now.to },
          userEvent: 'delete',
        });
      };
      const entries: MenuEntry[] = [
        ...(file
          ? [
              { label: 'Open', icon: 'arrow-up-right', run: () => workspace.openFile(file) },
              {
                label: 'Open in new tab',
                icon: 'file',
                run: () => workspace.openFile(file, { newTab: true }),
              },
              'separator' as const,
            ]
          : []),
        {
          // As it is written in the note: for another note of the vault.
          label: 'Copy as text',
          icon: 'copy',
          run: () => navigator.clipboard.writeText(embedSource(view, host)),
        },
        ...(view.state.readOnly ? [] : referenceEntries(() => view.posAtDOM(host))),
        ...(view.state.readOnly
          ? []
          : [
              {
                label: 'Remove from note…',
                icon: 'x',
                run: async () => {
                  const ok = await workspace.confirm(
                    `Remove ${name} from this note? The file stays in the vault.`,
                    { confirmLabel: 'Remove' },
                  );
                  if (ok) removeFromNote();
                },
              },
            ]),
      ];
      if (entries.length) workspace.showContextMenu(entries, at);
    };

    /** Corrections for the misspelled word that was right-clicked: first in the menu. */
    const spellingEntries = (
      view: EditorView,
      pos: number | null,
      found: { word: string; suggestions: string[] } | undefined,
    ): MenuEntry[] => {
      if (!found || pos === null) return [];
      // Where the word is: around the pointer (words with an apostrophe are two for the editor).
      const line = view.state.doc.lineAt(pos);
      let at = -1;
      for (let i = line.text.indexOf(found.word); i >= 0; i = line.text.indexOf(found.word, i + 1))
        if (line.from + i <= pos && pos <= line.from + i + found.word.length) at = line.from + i;
      if (at < 0) return [];
      const to = at + found.word.length;
      return [
        ...(found.suggestions.length
          ? found.suggestions.map((s) => ({
              label: s,
              run: () => {
                // The word as it is now (the note may have changed while the menu was open).
                if (view.state.sliceDoc(at, to) !== found.word) return;
                view.dispatch({
                  changes: { from: at, to, insert: s },
                  selection: { anchor: at + s.length },
                  userEvent: 'input',
                });
                view.focus();
              },
            }))
          : [{ label: 'No spelling suggestions', disabled: true, run: () => undefined }]),
        {
          label: `Add “${found.word}” to the dictionary`,
          icon: 'plus',
          run: () =>
            void shell.spelling
              ?.learn(found.word)
              .catch((e: unknown) =>
                workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' }),
              ),
        },
      ];
    };

    factories.push((ectx) =>
      EditorView.domEventHandlers({
        contextmenu(event, view) {
          const path = ectx.path();
          if (path === undefined) return false;
          // Right-clicking outside the selection moves the cursor there first.
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          const sel = view.state.selection.main;
          if (pos !== null && (pos < sel.from || pos > sel.to))
            view.dispatch({ selection: { anchor: pos } });
          const items = [...clipboardItems, ...menuItems]
            .filter((i) => !i.when || i.when(view, path))
            .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
          const entries: MenuEntry[] = [];
          let group = -1;
          for (const item of items) {
            const g = (item.order ?? 50) < 10 ? 0 : 1;
            if (group !== -1 && g !== group) entries.push('separator');
            group = g;
            entries.push({
              label: item.label,
              ...(item.icon ? { icon: item.icon } : {}),
              run: () =>
                Promise.resolve(item.run(view, path)).catch((e: unknown) =>
                  workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' }),
                ),
            });
          }
          const at = { x: event.clientX, y: event.clientY };
          if (!shell.spelling) {
            event.preventDefault();
            workspace.showContextMenu(entries, at);
            return true;
          }
          // The shell is asked about the word (it only hears of a right-click that is not
          // prevented; it shows no menu of its own).
          void shell.spelling
            .atPointer()
            .catch(() => undefined)
            .then((found) => {
              const corrections = spellingEntries(view, pos, found);
              workspace.showContextMenu(
                corrections.length ? [...corrections, 'separator', ...entries] : entries,
                at,
              );
            });
          // Not handled as far as the editor is concerned: it would prevent the default.
          return false;
        },
      }),
    );

    const insert =
      (text: string, cursorBack = 0) =>
      (view: EditorView) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length - cursorBack },
          userEvent: 'input',
        });
        view.focus();
      };
    const linePrefix = (prefix: LinePrefix) => (view: EditorView) => {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const c = linePrefixChange(line.text, prefix, head - line.from);
      // The cursor goes after what was added, also when it stood right where that went.
      view.dispatch({
        changes: { from: line.from + c.from, to: line.from + c.to, insert: c.insert },
        selection: { anchor: line.from + c.head },
        userEvent: 'input',
      });
      view.focus();
    };
    const defaults: EditorToolbarAction[] = [
      { id: 'undo', title: 'Undo', icon: 'undo', order: 0, run: (v) => (undo(v), v.focus()) },
      { id: 'redo', title: 'Redo', icon: 'redo', order: 1, run: (v) => (redo(v), v.focus()) },
      { id: 'link', title: 'Link to a note', icon: 'brackets', order: 10, run: insert('[[]]', 2) },
      { id: 'tag', title: 'Tag', icon: 'hash', order: 11, run: insert('#') },
      {
        id: 'task',
        title: 'Checklist item',
        icon: 'check-square',
        order: 12,
        run: linePrefix(TASK_PREFIX),
      },
      { id: 'bold', title: 'Bold', icon: 'bold', order: 20, run: (v) => toggleWrap(v, '**') },
      { id: 'italic', title: 'Italic', icon: 'italic', order: 21, run: (v) => toggleWrap(v, '*') },
      {
        id: 'heading',
        title: 'Heading',
        icon: 'heading',
        order: 22,
        run: linePrefix(HEADING_PREFIX),
      },
      {
        id: 'indent',
        title: 'Indent',
        icon: 'indent',
        order: 30,
        run: (v) => (indentMore(v), v.focus()),
      },
      {
        id: 'outdent',
        title: 'Outdent',
        icon: 'outdent',
        order: 31,
        run: (v) => (indentLess(v), v.focus()),
      },
      {
        id: 'hide-keyboard',
        title: 'Hide keyboard',
        icon: 'keyboard',
        order: 100,
        run: (v) => v.contentDOM.blur(),
      },
    ];
    for (const action of defaults) ctx.register(editorApi.registerToolbarAction(action));

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'editor',
          title: 'Editor',
          group: 'plugins',
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Editor'),
              settingItem(
                'Close \\left with \\right',
                'In a formula, typing \\left( adds the matching \\right) behind the cursor (also for [ \\{ | < and \\langle, \\lVert, \\lfloor, \\lceil).',
                toggle(
                  ctx.settings.get('closeLeft', true),
                  (on) => void ctx.settings.set('closeLeft', on),
                  { label: 'Close \\left with \\right' },
                ),
              ),
            );
          },
        }),
      );
    }

    ctx.commands.register({
      id: 'editor.edit-caption',
      title: 'Write the caption of the figure at the cursor',
      category: 'Editor',
      when: () => !!activeEditor(),
      run: () => {
        const view = activeEditor()?.editor;
        if (view && !editCaptionAtCursor(view))
          workspace.notify('The cursor is not beside a figure.', { timeout: 2000 });
      },
    });
    ctx.commands.register({
      id: 'editor.toggle-reading',
      title: 'Toggle reading view',
      category: 'Editor',
      hotkeys: ['Mod+E'],
      when: () => !!activeView(),
      run: () => {
        const view = activeView()!;
        view.setReading(!view.isReading);
      },
    });
    ctx.commands.register({
      id: 'editor.toggle-source-mode',
      title: 'Toggle live preview / source mode',
      category: 'Editor',
      run: () => {
        setSourceMode(!sourceMode);
        workspace.notify(sourceMode ? 'Source mode' : 'Live preview', { timeout: 1500 });
      },
    });
    for (const [mode, title] of [
      ['edit', 'Mode: edit (write, with everything drawn)'],
      ['read', 'Mode: read (nothing can be changed)'],
      ['source', 'Mode: source (the text as it is written)'],
    ] as const)
      ctx.commands.register({
        id: `editor.mode-${mode}`,
        title,
        category: 'Editor',
        when: () => !!activeView(),
        run: () => activeView()?.setMode(mode),
      });
    ctx.commands.register({
      id: 'editor.toggle-bold',
      title: 'Toggle bold',
      category: 'Editor',
      hotkeys: ['Mod+B'],
      when: () => !!activeEditor(),
      run: () => activeEditor() && toggleWrap(activeEditor()!.editor, '**'),
    });
    ctx.commands.register({
      id: 'editor.toggle-italic',
      title: 'Toggle italic',
      category: 'Editor',
      hotkeys: ['Mod+I'],
      when: () => !!activeEditor(),
      run: () => activeEditor() && toggleWrap(activeEditor()!.editor, '*'),
    });
    ctx.commands.register({
      id: 'editor.toggle-highlight',
      title: 'Toggle highlight',
      category: 'Editor',
      when: () => !!activeEditor(),
      run: () => activeEditor() && toggleWrap(activeEditor()!.editor, '=='),
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
