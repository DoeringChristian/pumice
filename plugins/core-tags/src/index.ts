import { MetadataIndex, Workspace, definePlugin, type PluginModule } from '@pumice/api';
import { createIcon, debounce, h } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

interface TagNode {
  name: string;
  full: string;
  count: number;
  children: Map<string, TagNode>;
}

export function tagTree(counts: Map<string, number>): TagNode[] {
  const root = new Map<string, TagNode>();
  // Group case-insensitively, keep the first spelling.
  for (const [tag, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = tag.split('/');
    let level = root;
    let full = '';
    parts.forEach((part, i) => {
      full = full ? `${full}/${part}` : part;
      const key = part.toLowerCase();
      let node = level.get(key);
      if (!node) level.set(key, (node = { name: part, full, count: 0, children: new Map() }));
      if (i === parts.length - 1) node.count += count;
      level = node.children;
    });
  }
  return [...root.values()];
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const index = ctx.use(MetadataIndex);
    const collapsed = new Set<string>(ctx.settings.get<string[]>('collapsed', []));

    ctx.register(
      workspace.registerView({
        type: 'tags',
        title: 'Tags',
        icon: 'tags',
        create(view) {
          const list = h('div', { class: 'pm-panel-scroll', role: 'tree' });
          view.container.append(h('div', { class: 'pm-panel' }, list));
          const renderNodes = (nodes: TagNode[], depth: number) => {
            for (const node of nodes.sort(
              (a, b) => b.count - a.count || a.name.localeCompare(b.name),
            )) {
              const hasChildren = node.children.size > 0;
              const isCollapsed = collapsed.has(node.full);
              const toggle = h(
                'span',
                { class: 'pm-tag-toggle' },
                hasChildren ? createIcon(isCollapsed ? 'chevron-right' : 'chevron-down', 12) : '',
              );
              toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isCollapsed) collapsed.delete(node.full);
                else collapsed.add(node.full);
                void ctx.settings.set('collapsed', [...collapsed]);
                render();
              });
              list.append(
                h(
                  'button',
                  {
                    class: 'pm-panel-item',
                    role: 'treeitem',
                    style: `padding-left: ${4 + depth * 14}px`,
                    onclick: () => void ctx.commands.execute('search.open', `tag:#${node.full}`),
                  },
                  toggle,
                  `#${node.name}`,
                  h(
                    'span',
                    { class: 'pm-panel-badge' },
                    String(index.tags().get(node.full) ?? node.count),
                  ),
                ),
              );
              if (hasChildren && !isCollapsed) renderNodes([...node.children.values()], depth + 1);
            }
          };
          const render = () => {
            list.replaceChildren();
            const tree = tagTree(index.tags());
            if (!tree.length)
              list.append(
                h('div', { class: 'pm-panel-empty' }, 'No tags yet. Type #tag in a note.'),
              );
            renderNodes(tree, 0);
          };
          const later = debounce(render, 300);
          const sub = index.onDidChange(later);
          render();
          return { dispose: () => (later.cancel(), sub.dispose()) };
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'tags',
        side: 'right',
        viewType: 'tags',
        title: 'Tags',
        icon: 'tags',
        order: 30,
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
