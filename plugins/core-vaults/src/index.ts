import {
  PlatformService,
  Workspace,
  definePlugin,
  type PluginModule,
  type QuickPickItem,
} from '@pumice/api';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

interface Choice extends QuickPickItem {
  run(): Promise<unknown>;
}

const ago = (ms: number) => {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days < 30 ? `${days} days ago` : new Date(ms).toLocaleDateString();
};

/** The server of a shared vault's link (`<server>/#open=<vault>&key=<key>`), or nothing. */
function sharedLink(text: string): string | undefined {
  try {
    const url = new URL(text);
    const params = new URLSearchParams(url.hash.slice(1));
    if (!/^https?:$/.test(url.protocol) || !params.get('open') || !params.get('key')) return;
    return url.host;
  } catch {
    return undefined;
  }
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const platform = ctx.use(PlatformService);
    const vaults = platform.vaults;
    // One fixed vault (web demo): nothing to switch.
    if (!vaults) return;
    const desktop = platform.kind === 'desktop';
    const web = platform.kind === 'web';

    const fail = (e: unknown) =>
      workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' });

    const createVault = async () => {
      const name = (
        await workspace.showPrompt({ title: 'Name of the new vault', placeholder: 'e.g. Notes' })
      )?.trim();
      if (name) await vaults.create!(name);
    };

    const choices = async (action: 'open' | 'forget'): Promise<Choice[]> => {
      const known = await vaults.list();
      const items: Choice[] = known
        .filter((v) => !v.current)
        .map((v) => ({
          label: v.name,
          ...(v.location ? { detail: v.location } : {}),
          ...(v.lastOpened ? { hint: ago(v.lastOpened) } : {}),
          run: () => (action === 'open' ? vaults.open(v.id) : vaults.forget(v.id)),
        }));
      if (action === 'forget') return items;
      if (desktop) {
        items.push(
          ...known
            .filter((v) => !v.current)
            .slice(0, 5)
            .map((v) => ({
              label: `${v.name} (new window)`,
              ...(v.location ? { detail: v.location } : {}),
              run: () => vaults.open(v.id, { newWindow: true }),
            })),
        );
      }
      items.push({
        label: desktop
          ? 'Open folder as vault…'
          : web
            ? 'Open another shared vault…'
            : 'Open a folder on this device…',
        detail: desktop
          ? 'Any folder works, including an Obsidian vault'
          : web
            ? 'From your server, or with an invite'
            : 'For example a synced Obsidian vault; asks for access to files',
        run: () => vaults.pick(),
      });
      if (desktop) {
        items.push({
          label: 'Open folder as vault in a new window…',
          run: () => vaults.pick({ newWindow: true }),
        });
      }
      if (vaults.create) items.push({ label: 'Create a new vault…', run: createVault });
      if (vaults.manage)
        items.push({
          label: 'Manage vaults…',
          detail: 'Create a vault, or remove one from the list',
          run: () => vaults.manage!(),
        });
      return items;
    };

    /** The vault switcher; a shared vault's link pasted into it opens that vault. */
    const switchVault = async () => {
      const items = await choices('open');
      const current = (await vaults.list()).find((v) => v.current);
      const picked = await workspace.showQuickPick<Choice>({
        placeholder: vaults.add
          ? `Switch vault (current: ${current?.name ?? platform.vaultName}), or paste a shared vault’s link`
          : `Switch vault (current: ${current?.name ?? platform.vaultName})`,
        items: (query) => {
          const text = query.trim();
          const link = vaults.add ? sharedLink(text) : undefined;
          if (link)
            return [
              { label: 'Open this shared vault', detail: link, run: () => vaults.add!(text) },
            ];
          const words = text.toLowerCase().split(/\s+/).filter(Boolean);
          return items.filter((i) => {
            const said = `${i.label} ${i.detail ?? ''}`.toLowerCase();
            return words.every((w) => said.includes(w));
          });
        },
      });
      await picked?.run().catch(fail);
    };

    ctx.commands.register({
      id: 'vaults.switch',
      title: 'Switch vault…',
      category: 'Vault',
      hotkeys: ['Mod+Shift+O'],
      run: switchVault,
    });
    ctx.commands.register({
      id: 'vaults.open-folder',
      title: desktop
        ? 'Open folder as vault…'
        : web
          ? 'Open another shared vault…'
          : 'Open a folder on this device as vault…',
      category: 'Vault',
      run: () => vaults.pick().catch(fail),
    });
    if (vaults.add) {
      ctx.commands.register({
        id: 'vaults.open-shared',
        title: 'Open a shared vault (paste its link)…',
        category: 'Vault',
        run: switchVault,
      });
    }
    if (vaults.create) {
      ctx.commands.register({
        id: 'vaults.create',
        title: 'Create a new vault…',
        category: 'Vault',
        run: () => createVault().catch(fail),
      });
    }
    ctx.commands.register({
      id: 'vaults.forget',
      title: 'Remove a vault from the list…',
      category: 'Vault',
      run: async () => {
        const picked = await workspace.showQuickPick({
          placeholder: 'Remove from the list (files are not deleted)',
          items: await choices('forget'),
        });
        await picked?.run().catch(fail);
      },
    });
    ctx.register(
      workspace.registerRibbonAction({
        id: 'vaults.switch',
        icon: 'folder-open',
        title: 'Switch vault',
        order: 5,
        run: switchVault,
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
