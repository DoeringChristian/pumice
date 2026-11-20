import {
  Links,
  MetadataIndex,
  Workspace,
  definePlugin,
  type PluginContext,
  type PluginModule,
  type ViewInstance,
} from '@pumice/api';
import { debounce, h, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { GraphCanvas, buildGraph, type GraphOptions } from './graph';
import './graph.css';

export { buildGraph } from './graph';
export const manifest = manifestJson;

function createGraphView(ctx: PluginContext, container: HTMLElement, local: boolean): ViewInstance {
  const index = ctx.use(MetadataIndex);
  const workspace = ctx.use(Workspace);
  const key = local ? 'local' : 'global';
  const opts: GraphOptions = {
    depth: 1,
    showOrphans: true,
    showAttachments: false,
    showTags: false,
    showUnresolved: false,
    filter: '',
    ...ctx.settings.get<Partial<GraphOptions>>(key, {}),
  };
  const save = () => void ctx.settings.set(key, { ...opts, center: undefined, filter: undefined });

  const stage = h('div', { class: 'pm-graph-stage' });
  const graph = new GraphCanvas(stage, (node, newTab) => {
    if (node.path) void workspace.openFile(node.path, { newTab });
    else if (node.kind === 'tag') void ctx.commands.execute('search.open', `tag:${node.label}`);
    else if (node.kind === 'unresolved') {
      const links = ctx.tryUse(Links);
      const from = workspace.activeFile ?? '';
      if (links) void links.openLink(node.label, { sourcePath: from, newTab });
    }
  });

  const rebuild = () => {
    if (local) {
      opts.center = workspace.activeFile;
      if (!opts.center) {
        graph.setData([], []);
        return;
      }
    }
    const { nodes, links } = buildGraph(index, opts);
    graph.active = workspace.activeFile;
    graph.setData(nodes, links);
    count.textContent = `${nodes.length} notes · ${links.length} links`;
  };
  const later = debounce(rebuild, 400);

  const option = (
    label: string,
    prop: 'showOrphans' | 'showAttachments' | 'showTags' | 'showUnresolved',
  ) =>
    h(
      'label',
      { class: 'pm-graph-option' },
      toggle(opts[prop], (v) => ((opts[prop] = v), save(), rebuild()), { label }),
      label,
    );
  const filter = h('input', {
    class: 'pm-panel-input',
    type: 'search',
    placeholder: 'Filter…',
    'aria-label': 'Filter notes',
  });
  filter.addEventListener(
    'input',
    debounce(() => ((opts.filter = filter.value), rebuild()), 200),
  );
  const depth = h('input', {
    type: 'range',
    min: 1,
    max: 4,
    value: String(opts.depth),
    'aria-label': 'Depth',
  });
  depth.addEventListener('input', () => ((opts.depth = Number(depth.value)), save(), rebuild()));
  const count = h('span', { class: 'pm-graph-count' });
  const controls = h(
    'details',
    { class: 'pm-graph-controls' },
    h('summary', {}, 'Display'),
    filter,
    local ? h('label', { class: 'pm-graph-option' }, 'Depth ', depth) : null,
    option('Orphans', 'showOrphans'),
    option('Attachments', 'showAttachments'),
    option('Tags', 'showTags'),
    option('Unresolved links', 'showUnresolved'),
    count,
  );
  container.classList.add('pm-graph-view');
  container.append(stage, controls);

  const subs = [
    index.onDidChange(later),
    workspace.onDidChangeActiveFile(() => {
      if (local) rebuild();
      else {
        graph.active = workspace.activeFile;
        graph.draw();
      }
    }),
  ];
  const themeObserver = new MutationObserver(() => graph.refreshColors());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style'],
  });
  void index.ready.then(rebuild);
  rebuild();
  return {
    dispose() {
      later.cancel();
      subs.forEach((s) => s.dispose());
      themeObserver.disconnect();
      graph.dispose();
    },
  };
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    ctx.register(
      workspace.registerView({
        type: 'graph',
        title: 'Graph',
        icon: 'git-fork',
        create: (view) => {
          view.setTitle('Graph');
          return createGraphView(ctx, view.container, false);
        },
      }),
    );
    ctx.register(
      workspace.registerView({
        type: 'local-graph',
        title: 'Local graph',
        icon: 'network',
        create: (view) => createGraphView(ctx, view.container, true),
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'local-graph',
        side: 'right',
        viewType: 'local-graph',
        title: 'Local graph',
        icon: 'network',
        order: 40,
      }),
    );
    ctx.register(
      workspace.registerRibbonAction({
        id: 'graph.open',
        icon: 'network',
        title: 'Graph view',
        order: 50,
        run: () => ctx.commands.execute('graph.open'),
      }),
    );
    ctx.commands.register({
      id: 'graph.open',
      title: 'Open graph view',
      category: 'Graph',
      hotkeys: ['Mod+G'],
      run: () => workspace.openView('graph', { newTab: true }),
    });
    ctx.commands.register({
      id: 'graph.open-local',
      title: 'Open local graph',
      category: 'Graph',
      run: () => workspace.openView('local-graph', { location: 'right' }),
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
