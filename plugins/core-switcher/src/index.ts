import {
  Vault,
  Workspace,
  definePlugin,
  newNoteContent,
  dirname,
  type PluginModule,
  type QuickPickItem,
} from '@pumice/api';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

interface FileItem extends QuickPickItem {
  path?: string;
  create?: string;
}

const MAX_RECENT = 50;

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    let recent = ctx.settings.get<string[]>('recent', []);

    ctx.register(
      workspace.onDidChangeActiveFile((path) => {
        if (!path) return;
        recent = [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
        void ctx.settings.set('recent', recent);
      }),
    );
    ctx.register(
      vault.onDidChange((changes) => {
        let dirty = false;
        for (const c of changes) {
          if (c.type === 'rename') {
            recent = recent.map((p) => (p === c.oldPath ? c.entry.path : p));
            dirty = true;
          } else if (c.type === 'delete') {
            recent = recent.filter((p) => p !== c.path);
            dirty = true;
          }
        }
        if (dirty) void ctx.settings.set('recent', recent);
      }),
    );

    ctx.register(
      workspace.registerRibbonAction({
        id: 'switcher.open',
        icon: 'search',
        title: 'Quick switcher',
        order: 30,
        run: () => ctx.commands.execute('switcher.open'),
      }),
    );
    ctx.commands.register({
      id: 'switcher.open',
      title: 'Open quick switcher',
      category: 'Navigation',
      hotkeys: ['Mod+O'],
      run: async () => {
        const rank = new Map(recent.map((p, i) => [p, i]));
        const items: FileItem[] = vault
          .files()
          .sort(
            (a, b) =>
              (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity) || b.mtime - a.mtime,
          )
          .map((f) => ({
            label: f.extension === 'md' ? f.basename : f.name,
            detail: dirname(f.path),
            path: f.path,
          }));
        const picked = await workspace.showQuickPick<FileItem>({
          placeholder: 'Find or create a note…',
          items,
          onEmpty: (query) => ({ label: `Create “${query}”`, hint: 'new note', create: query }),
        });
        if (!picked) return;
        if (picked.path) {
          await workspace.openFile(picked.path);
        } else if (picked.create) {
          const name = picked.create.replace(/\.md$/i, '');
          const folder = name.includes('/') ? dirname(name) : '';
          const base = name.slice(name.lastIndexOf('/') + 1);
          const path = vault.availablePath(folder, base, 'md');
          await vault.create(path, newNoteContent());
          await workspace.openFile(path);
        }
      },
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
