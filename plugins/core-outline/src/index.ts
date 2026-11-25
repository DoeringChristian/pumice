import {
  Documents,
  Editor,
  MetadataIndex,
  Reader,
  Vault,
  Workspace,
  definePlugin,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { debounce, h } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';
import { DEFAULT_TOC, TOC_LINE, parseTocBlock, tocEntries, type TocOptions } from './toc';
import { tocLines } from './toc-editor';
import './toc.css';

export const manifest = manifestJson;
export * from './toc';

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const index = ctx.use(MetadataIndex);

    ctx.register(
      workspace.registerView({
        type: 'outline',
        title: 'Outline',
        icon: 'list-tree',
        create(view) {
          const list = h('div', { class: 'pm-panel-scroll', role: 'tree' });
          view.container.append(h('div', { class: 'pm-panel' }, list));
          const render = () => {
            const path = workspace.activeFile;
            const headings = path ? (index.getFile(path)?.meta?.headings ?? []) : [];
            list.replaceChildren();
            if (!path) list.append(h('div', { class: 'pm-panel-empty' }, 'No note open.'));
            else if (!headings.length)
              list.append(h('div', { class: 'pm-panel-empty' }, 'No headings.'));
            const minLevel = Math.min(...headings.map((x) => x.level));
            for (const heading of headings) {
              list.append(
                h(
                  'button',
                  {
                    class: 'pm-panel-item',
                    role: 'treeitem',
                    style: `padding-left: ${8 + (heading.level - minLevel) * 14}px`,
                    title: heading.text,
                    onclick: () =>
                      void workspace.openFile(path!, { state: { subpath: heading.text } }),
                  },
                  heading.text || '(empty heading)',
                ),
              );
            }
          };
          const later = debounce(render, 150);
          const subs = [workspace.onDidChangeActiveFile(render), index.onDidChange(later)];
          render();
          return { dispose: () => (later.cancel(), subs.forEach((s) => s.dispose())) };
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'outline',
        side: 'right',
        viewType: 'outline',
        title: 'Outline',
        icon: 'list-tree',
        order: 20,
      }),
    );

    // ---- a table of contents in the note itself -------------------------------------------
    const documents = ctx.tryUse(Documents);
    const vault = ctx.tryUse(Vault);
    const noteText = async (path: VaultPath) =>
      documents?.peek(path) ?? (await vault?.read(path).catch(() => '')) ?? '';
    /**
     * Draws the table of contents of a note into `container` and keeps it current as the
     * headings change. `source`: the text of the block (its settings), to find where it stands.
     */
    const drawToc = (
      container: HTMLElement,
      path: VaultPath,
      options: TocOptions,
      source?: string,
    ): (() => void) => {
      let ended = false;
      const draw = async () => {
        const headings = index.getFile(path)?.meta?.headings ?? [];
        let below: number | undefined;
        if (options.from === 'below') {
          const text = await noteText(path);
          // Where this block is: its own text, or the line that stands for it.
          const at =
            source !== undefined ? text.indexOf(`\`\`\`toc\n${source}`) : text.search(/^\[toc\]/im);
          below = at >= 0 ? at : undefined;
        }
        if (ended) return;
        const entries = tocEntries(headings, options, below);
        const list = h('div', { class: 'pm-toc-list' });
        for (const entry of entries)
          list.append(
            h(
              'div',
              { class: 'pm-toc-entry', style: `--pm-toc-level:${entry.level}` },
              entry.number ? h('span', { class: 'pm-toc-number' }, entry.number) : null,
              // A link to the heading, as `[[#Heading]]` is one: it works wherever those do.
              h(
                'a',
                {
                  class: 'internal-link pm-toc-link',
                  href: '#',
                  'data-target': '',
                  'data-subpath': entry.text,
                },
                entry.text,
              ),
            ),
          );
        container.classList.add('pm-toc');
        container.replaceChildren(
          ...(options.title ? [h('div', { class: 'pm-toc-title' }, options.title)] : []),
          entries.length ? list : h('div', { class: 'pm-toc-empty' }, 'No headings to list.'),
        );
      };
      void draw();
      const later = debounce(() => void draw(), 200);
      const sub = index.onDidChange(later);
      return () => {
        ended = true;
        later.cancel();
        sub.dispose();
      };
    };
    const openHeading = (path: VaultPath, heading: string) =>
      void workspace.openFile(path, { state: { subpath: heading } });

    const reader = ctx.tryUse(Reader);
    if (reader) {
      ctx.register(
        reader.registerCodeBlockRenderer({
          language: 'toc',
          render(source, container, rctx) {
            rctx.register(drawToc(container, rctx.sourcePath, parseTocBlock(source), source));
          },
        }),
      );
      // A paragraph that is nothing but `[TOC]`.
      ctx.register(
        reader.registerPostProcessor((root, rctx) => {
          for (const p of root.querySelectorAll('p')) {
            if (p.children.length || !TOC_LINE.test(p.textContent ?? '')) continue;
            const box = h('div', {});
            p.replaceWith(box);
            rctx.register(drawToc(box, rctx.sourcePath, DEFAULT_TOC));
          }
        }),
      );
    }

    const editor = ctx.tryUse(Editor);
    if (editor) {
      ctx.register(
        editor.registerExtension((ectx) =>
          tocLines(ectx, (container, path) => {
            // In the note itself a click goes to the heading (nothing else handles it here).
            container.addEventListener('mousedown', (e) => {
              const link = (e.target as HTMLElement).closest<HTMLElement>('.pm-toc-link');
              if (!link) return;
              e.preventDefault();
              openHeading(path, link.dataset.subpath ?? '');
            });
            return drawToc(container, path, DEFAULT_TOC);
          }),
        ),
      );
      ctx.commands.register({
        id: 'outline.insert-toc',
        title: 'Insert table of contents',
        category: 'Outline',
        when: () => !!editor.active(),
        run: () => {
          const active = editor.active();
          if (!active) return;
          const { state } = active.view;
          const line = state.doc.lineAt(state.selection.main.head);
          // On a line of its own, with an empty line around it where there is text.
          const before = line.text.trim() ? '\n\n' : '';
          const block = '```toc\n```';
          const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : '';
          const insert = `${before}${block}${next.trim() ? '\n' : ''}`;
          active.view.dispatch({
            changes: { from: line.to, insert },
            selection: { anchor: line.to + insert.length },
            userEvent: 'input',
          });
          active.view.focus();
        },
      });
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
