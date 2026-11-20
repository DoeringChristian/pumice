import {
  Workspace,
  definePlugin,
  formatHotkey,
  type PluginModule,
  type QuickPickItem,
} from '@pumice/api';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

interface CommandItem extends QuickPickItem {
  id: string;
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const isMac = ctx.platform.os === 'macos' || ctx.platform.os === 'ios';
    let recent = ctx.settings.get<string[]>('recent', []);

    ctx.register(
      workspace.registerRibbonAction({
        id: 'palette.open',
        icon: 'command',
        title: 'Command palette',
        order: 40,
        run: () => ctx.commands.execute('palette.open'),
      }),
    );
    ctx.commands.register({
      id: 'palette.open',
      title: 'Open command palette',
      category: 'Navigation',
      hotkeys: ['Mod+P', 'Mod+Shift+P'],
      run: async () => {
        const rank = new Map(recent.map((id, i) => [id, i]));
        const items: CommandItem[] = ctx.commands
          .list()
          .filter((c) => c.id !== 'palette.open')
          .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
          .map((c) => ({
            id: c.id,
            label: c.category ? `${c.category}: ${c.title}` : c.title,
            hint: c.hotkeys[0] ? formatHotkey(c.hotkeys[0], isMac) : undefined,
          }));
        const picked = await workspace.showQuickPick({ placeholder: 'Type a command…', items });
        if (!picked) return;
        recent = [picked.id, ...recent.filter((id) => id !== picked.id)].slice(0, 20);
        void ctx.settings.set('recent', recent);
        try {
          await ctx.commands.execute(picked.id);
        } catch (e) {
          workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' });
        }
      },
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
