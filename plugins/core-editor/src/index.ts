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
  Reader,
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
import manifestJson from '../manifest.json';
import { embedAt } from './resize';
import './editor.css';
import { MarkdownView } from './markdown-view';
import { HEADING_PREFIX, linePrefixChange, TASK_PREFIX, type LinePrefix } from './toolbar';

export { MarkdownView } from './markdown-view';

export const manifest = manifestJson;

/** Wraps the selection in `marker` or removes it if already wrapped. */
function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - marker.length, range.from);
      const after = state.sliceDoc(range.to, range.to + marker.length);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - marker.length, to: range.from },
            { from: range.to, to: range.to + marker.length },
          ],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
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
    let active: MarkdownView | undefined;
    let sourceMode = ctx.settings.get('sourceMode', false);

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
              sourceMode: () => sourceMode,
              openExternal: (url) => void shell.openExternal(url),
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
        extensions: ['md', 'markdown', 'txt'],
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

    /** Open, remove from the note, or delete the file of an embedded picture, video or frame. */
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
              ...(file
                ? [
                    {
                      label: 'Delete file…',
                      icon: 'trash',
                      danger: true,
                      run: async () => {
                        const others = new Set(
                          (index?.backlinks(file) ?? [])
                            .map((l) => l.source)
                            .filter((p) => p !== notePath),
                        ).size;
                        const ok = await workspace.confirm(
                          `Delete ${name} from the vault and remove it from this note?${
                            others
                              ? ` It is also used in ${others} other note${others === 1 ? '' : 's'}, where it will be missing.`
                              : ''
                          }`,
                          { confirmLabel: 'Delete', danger: true },
                        );
                        if (!ok) return;
                        removeFromNote();
                        await vault.delete(file);
                      },
                    },
                  ]
                : []),
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
        sourceMode = !sourceMode;
        void ctx.settings.set('sourceMode', sourceMode);
        for (const v of views) {
          v.setSourceMode(sourceMode);
          v.reconfigureContributed();
        }
        workspace.notify(sourceMode ? 'Source mode' : 'Live preview', { timeout: 1500 });
      },
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
