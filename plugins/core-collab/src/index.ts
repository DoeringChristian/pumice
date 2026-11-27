import {
  Documents,
  PlatformService,
  SettingsUi,
  Vault,
  Workspace,
  definePlugin,
  type PluginContext,
  type PluginModule,
} from '@pumice/api';
import type { PublicUser, Role } from '@pumice/collab-protocol';
import { button, h, settingItem } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { CollabClient } from './client';
import { SharedVault, type Presence } from './shared-vault';
import './collab.css';

export { CollabClient } from './client';
export { SharedVault, kindOf } from './shared-vault';
export const manifest = manifestJson;

/** Device-local link between this vault folder and an account / shared vault. */
interface Link {
  server: string;
  token?: string;
  user?: PublicUser;
  vaultId?: string;
  vaultName?: string;
  role?: Role;
}

const LINK_KEY = 'link';
const DEFAULT_SERVER = 'http://localhost:8787';

async function readLink(ctx: PluginContext): Promise<Link> {
  try {
    return {
      server: DEFAULT_SERVER,
      ...(JSON.parse((await ctx.storage.get(LINK_KEY)) ?? '{}') as Partial<Link>),
    };
  } catch {
    return { server: DEFAULT_SERVER };
  }
}

export const plugin = definePlugin({
  async activate(ctx) {
    const vault = ctx.use(Vault);
    const documents = ctx.use(Documents);
    const workspace = ctx.use(Workspace);
    // A shared vault (docs/plan/10): what to keep in step comes with the vault; else a folder
    // linked to one from these settings (before vaults could be shared ones).
    const sharedVault = ctx.tryUse(PlatformService)?.shared;
    let link: Link = sharedVault
      ? {
          server: sharedVault.server,
          token: sharedVault.token,
          user: sharedVault.user,
          vaultId: sharedVault.vaultId,
          vaultName: sharedVault.vaultName,
          role: sharedVault.role,
        }
      : await readLink(ctx);
    let client: CollabClient | undefined;
    let shared: SharedVault | undefined;
    let providerReg: { dispose(): void } | undefined;
    const listeners: Array<{ dispose(): void }> = [];
    const refreshUi = new Set<() => void>();
    const saveLink = async () => {
      await ctx.storage.set(LINK_KEY, JSON.stringify(link));
      for (const r of refreshUi) r();
    };

    const status = ctx.register(workspace.addStatusBarItem(20));
    status.setOnClick(() => void showVault(), 'Who is here, and the vault’s link');
    const updateStatus = () => {
      if (!shared || !client) return status.setText('');
      const others = shared.presence();
      const state = client.state === 'online' ? '●' : client.state === 'connecting' ? '◌' : '○';
      status.setText(
        `${state} ${link.vaultName ?? 'Shared'}${others.length ? ` · ${others.length} online` : ''}${shared.readOnly ? ' · read-only' : ''}`,
      );
      for (const r of refreshUi) r();
    };

    const stop = () => {
      for (const l of listeners.splice(0)) l.dispose();
      providerReg?.dispose();
      providerReg = undefined;
      void shared?.flush();
      shared?.dispose();
      shared = undefined;
      client?.dispose();
      client = undefined;
      updateStatus();
    };

    const start = async (opts: { seed?: boolean } = {}) => {
      stop();
      if (!link.token || !link.vaultId || !link.user) return;
      client = new CollabClient(link.server, link.token);
      shared = new SharedVault({
        client,
        vaultId: link.vaultId,
        user: link.user,
        role: link.role ?? 'editor',
        vault,
        documents,
        storage: ctx.storage,
        notify: (m, kind) => workspace.notify(m, { kind: kind ?? 'info' }),
      });
      const current = shared;
      await current.init();
      providerReg = documents.registerProvider(current.provider());
      listeners.push(
        client.onDidChangeState(updateStatus),
        current.onDidChangePresence(updateStatus),
      );
      listeners.push(workspace.onDidChangeActiveFile((p) => current.setActiveFile(p)));
      client.connect();
      // Scanning the folder and syncing run in the background.
      void current.run({ seedFromDisk: !!opts.seed }).then(() => {
        current.setActiveFile(workspace.activeFile);
        updateStatus();
      });
      updateStatus();
    };
    ctx.register(stop);

    // Flush the local replica when the app goes to the background or quits.
    const platform = ctx.tryUse(PlatformService);
    if (platform) ctx.register(platform.lifecycle.onPause(() => void shared?.flush()));

    if (link.vaultId) {
      // The local replica must be ready before notes open (startup waits for this, not the network).
      await start().catch((e) =>
        workspace.notify(`Collaboration could not start: ${e instanceof Error ? e.message : e}`, {
          kind: 'error',
        }),
      );
    }

    /** The vault's link (a served folder's; whoever has it can do everything), if there is one. */
    const vaultLink = async (): Promise<string | undefined> => {
      if (!link.vaultId || !link.token) return undefined;
      const r = await fetch(`${link.server}/api/vaults/${link.vaultId}/link`, {
        headers: { Authorization: `Bearer ${link.token}` },
      }).catch(() => undefined);
      if (!r?.ok) return undefined;
      const { key } = (await r.json()) as { key: string };
      return `${link.server}/#open=${link.vaultId}&key=${key}`;
    };

    /** The status bar's vault: its connection, who is here, and its link. */
    const showVault = async () => {
      if (!shared || !client) return;
      const state =
        client.state === 'online'
          ? 'connected'
          : client.state === 'connecting'
            ? 'connecting…'
            : 'offline, changes go out when back';
      const others = shared.presence();
      const shareable = await vaultLink();
      type Item = { label: string; detail?: string; run: () => unknown };
      const items: Item[] = [
        ...(shareable
          ? [
              {
                label: 'Copy the vault’s link',
                detail: 'Whoever has it can open and edit the vault, and run its agents',
                run: async () => {
                  await navigator.clipboard.writeText(shareable);
                  workspace.notify('Link copied.');
                },
              },
            ]
          : []),
        ...others.map((p: Presence) => ({
          label: p.user.name,
          detail: p.file ? `in ${p.file}` : 'no note open',
          run: async () => {
            if (p.file && vault.get(p.file)) await workspace.openFile(p.file);
          },
        })),
      ];
      const picked = await workspace.showQuickPick({
        placeholder: `${link.vaultName ?? 'Shared vault'}: ${state} · ${others.length ? `${others.length} here besides you` : 'nobody else here'}`,
        items,
      });
      await picked?.run();
    };

    const showPresence = async () => {
      const others = shared?.presence() ?? [];
      if (!others.length) {
        workspace.notify('Nobody else is here right now.');
        return;
      }
      const pick = await workspace.showQuickPick({
        placeholder: 'Go to a collaborator’s note',
        items: others.map((p: Presence) => ({
          label: p.user.name,
          detail: p.file ?? 'no note open',
          path: p.file,
        })),
      });
      if (pick?.path && vault.get(pick.path)) await workspace.openFile(pick.path);
    };
    status.setText('');
    ctx.commands.register({
      id: 'collab.presence',
      title: 'Who’s here',
      category: 'Collaboration',
      when: () => !!shared,
      run: showPresence,
    });

    ctx.commands.register({
      id: 'collab.history',
      title: 'Show version history of this note',
      category: 'Collaboration',
      when: () => !!shared && !!workspace.activeFile && !!shared.idOf(workspace.activeFile),
      run: async () => {
        const path = workspace.activeFile!;
        const id = shared!.idOf(path)!;
        const snapshots = await client!.history(link.vaultId!, id);
        if (!snapshots.length) {
          workspace.notify(
            'No history yet: versions are kept every 10 minutes while a note is edited.',
          );
          return;
        }
        const pick = await workspace.showQuickPick({
          placeholder: 'Restore a version',
          items: snapshots.map((s) => ({
            label: new Date(s.createdAt).toLocaleString(),
            detail: `${(s.size / 1024).toFixed(1)} KB`,
            id: s.id,
          })),
        });
        if (!pick) return;
        const text = await shared!.snapshotText(path, pick.id);
        if (text === undefined) return;
        if (
          !(await workspace.confirm(
            `Restore “${path}” to the version from ${pick.label}? Collaborators see the change; it can be undone by restoring a newer version.`,
            { confirmLabel: 'Restore' },
          ))
        )
          return;
        const handle = await documents.open(path);
        try {
          handle.codec.mergeExternal(handle.doc, handle.text(), text, path);
        } finally {
          handle.dispose();
        }
      },
    });

    const settingsUi = ctx.tryUse(SettingsUi);
    if (!settingsUi) return;
    ctx.register(
      settingsUi.registerTab({
        id: 'collab',
        title: 'Collaboration',
        order: 40,
        render(container) {
          const error = h('div', { class: 'pm-plugin-error' });
          const run = async (task: () => Promise<unknown>) => {
            error.textContent = '';
            try {
              await task();
            } catch (e) {
              error.textContent = e instanceof Error ? e.message : String(e);
            }
            render();
          };
          const render = () => {
            const parts: Array<Node | null> = [
              h('h2', {}, 'Collaboration'),
              h(
                'p',
                { class: 'pm-setting-desc' },
                'Edit notes and drawings together in real time. The folder stays plain files on every device; a Pumice server relays changes and keeps history.',
              ),
            ];
            if (!link.vaultId) {
              parts.push(
                h(
                  'p',
                  { class: 'pm-setting-desc' },
                  'This vault is not shared. To open a shared vault, paste its link into the vault switcher (click the vault’s name, top left).',
                ),
              );
            } else {
              const state = client?.state ?? 'offline';
              parts.push(
                h('h3', {}, 'This vault'),
                settingItem(
                  link.vaultName ?? 'Shared vault',
                  `${state === 'online' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Offline — changes sync when the connection is back'} · your role: ${shared?.role ?? link.role}`,
                  // (A shared vault is removed from the list instead; a folder kept in step
                  // with one, from before, stops here.)
                  sharedVault
                    ? null
                    : button(
                        'Stop syncing this folder',
                        () =>
                          void run(async () => {
                            if (
                              !(await workspace.confirm(
                                'Stop syncing this folder? Files stay here; the shared vault stays on the server.',
                                { confirmLabel: 'Stop syncing' },
                              ))
                            )
                              return;
                            stop();
                            link = { server: link.server, token: link.token, user: link.user };
                            await saveLink();
                          }),
                      ),
                ),
              );
              const others = shared?.presence() ?? [];
              parts.push(
                settingItem(
                  'Here now',
                  others.length ? null : 'Nobody else right now.',
                  h(
                    'div',
                    { class: 'pm-presence' },
                    ...others.map((p) =>
                      h(
                        'span',
                        {
                          class: 'pm-avatar',
                          style: `background:${p.user.color}`,
                          title: `${p.user.name}${p.file ? ` — ${p.file}` : ''}`,
                        },
                        p.user.name.slice(0, 1).toUpperCase(),
                      ),
                    ),
                  ),
                ),
              );
            }
            parts.push(error);
            container.replaceChildren(...parts.filter((p): p is Node => p !== null));
          };
          refreshUi.add(render);
          render();
          return () => refreshUi.delete(render);
        },
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
