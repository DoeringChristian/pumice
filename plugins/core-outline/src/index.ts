import { MetadataIndex, Workspace, definePlugin, type PluginModule } from '@pumice/api';
import { debounce, h } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

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
  },
});

export default { manifest, plugin } satisfies PluginModule;
