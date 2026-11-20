import type { EditorView } from '@codemirror/view';
import {
  Editor,
  Links,
  MarkdownSyntax,
  SettingsUi,
  Workspace,
  definePlugin,
  emptyTable,
  formatTable,
  tableFromDelimited,
  type PluginModule,
} from '@pumice/api';
import { h, settingItem, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { requestFocus, tableEditing } from './widget';
import './tables.css';

export const manifest = manifestJson;
export { tableEditing } from './widget';

/** Inserts `markdown` as its own block at the cursor (blank lines around it). Returns its start. */
function insertBlock(view: EditorView, markdown: string): number {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const replaceSelection = !sel.empty;
  let from = replaceSelection ? sel.from : line.text.trim() ? endLine.to : line.from;
  let to = replaceSelection ? sel.to : from;
  if (replaceSelection) {
    from = line.from;
    to = endLine.to;
  }
  const before =
    from > 0 && state.doc.sliceString(from - 1, from) !== '\n'
      ? '\n\n'
      : from > 0 && state.doc.lineAt(from - 1).text.trim()
        ? '\n'
        : '';
  const after =
    to < state.doc.length && state.doc.lineAt(Math.min(to + 1, state.doc.length)).text.trim()
      ? '\n'
      : '';
  const insert = `${before}${markdown}\n${after}`;
  view.dispatch({ changes: { from, to, insert }, userEvent: 'input.table' });
  return from + before.length;
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const editor = ctx.use(Editor);
    const syntax = ctx.use(MarkdownSyntax);

    const renderInline = (markdown: string) => {
      if (!markdown.trim()) return '';
      const html = syntax.renderHtml(syntax.parse(markdown.replace(/\\\|/g, '\\|')));
      return html.replace(/^<p>/, '').replace(/<\/p>\s*$/, '');
    };

    ctx.register(
      editor.registerExtension((ectx) =>
        tableEditing({
          renderInline,
          showMenu: (entries, at) => workspace.showContextMenu(entries, at),
          openLink: (a) => {
            const source = ectx.path();
            const target = a.dataset.target;
            if (target !== undefined && source !== undefined) {
              void ctx.tryUse(Links)?.openLink(target, {
                sourcePath: source,
                ...(a.dataset.subpath ? { subpath: a.dataset.subpath } : {}),
              });
            } else if (a.href && !a.href.endsWith('#')) {
              window.open(a.href, '_blank', 'noopener');
            }
          },
          sourceMode: ectx.sourceMode,
          formatOnLeave: () => ctx.settings.get('formatOnLeave', true),
        }),
      ),
    );

    const insertTable = (cols = 3, rows = 2) => {
      const active = editor.active();
      if (!active) return;
      const start = insertBlock(active.view, formatTable(emptyTable(cols, rows)));
      requestFocus(active.view, { table: start, row: 0, col: 0, caret: 'all' });
    };

    ctx.commands.register({
      id: 'tables.insert',
      title: 'Insert table',
      category: 'Tables',
      hotkeys: ['Mod+Alt+T'],
      when: () => !!editor.active(),
      run: async (size?: unknown) => {
        let cols = 3;
        let rows = 2;
        if (typeof size === 'string' && /^\d+x\d+$/.test(size)) {
          [cols, rows] = size.split('x').map(Number) as [number, number];
        } else if (size === undefined) {
          const answer = await workspace.showPrompt({
            title: 'Table size (columns × rows)',
            value: '3x2',
            placeholder: 'e.g. 3x2',
          });
          if (answer === undefined) return;
          const m = /^\s*(\d+)\s*[x×*,]\s*(\d+)\s*$/.exec(answer);
          if (m) [cols, rows] = [Number(m[1]), Number(m[2])];
        }
        insertTable(Math.max(1, Math.min(cols, 30)), Math.max(0, Math.min(rows, 500)));
      },
    });
    ctx.commands.register({
      id: 'tables.from-selection',
      title: 'Convert selection (CSV/TSV) to table',
      category: 'Tables',
      when: () => !!editor.active() && !editor.active()!.view.state.selection.main.empty,
      run: () => {
        const view = editor.active()?.view;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        const data = tableFromDelimited(view.state.sliceDoc(from, to));
        if (!data) {
          workspace.notify('The selection is not comma- or tab-separated text.', {
            kind: 'warning',
          });
          return;
        }
        insertBlock(view, formatTable(data));
      },
    });

    ctx.register(
      editor.registerContextMenuItem({
        id: 'tables.insert',
        label: 'Insert table',
        icon: 'table',
        order: 30,
        when: (v) => !v.state.readOnly,
        run: () => insertTable(),
      }),
    );
    ctx.register(
      editor.registerToolbarAction({
        id: 'tables.insert',
        title: 'Insert table',
        icon: 'table',
        order: 70,
        run: () => insertTable(),
      }),
    );

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'tables',
          title: 'Tables',
          group: 'plugins',
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Tables'),
              settingItem(
                'Format tables when leaving them',
                'Pad columns so the markdown source lines up.',
                toggle(
                  ctx.settings.get('formatOnLeave', true),
                  (v) => void ctx.settings.set('formatOnLeave', v),
                ),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
