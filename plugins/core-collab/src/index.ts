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
import { button, h, select, settingItem, textInput } from '@pumice/ui';
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
    let link = await readLink(ctx);
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

    const accountClient = () => new CollabClient(link.server, link.token);

    const share = async () => {
      const c = accountClient();
      const name = await workspace.showPrompt({
        title: 'Name of the shared vault',
        value: vault.name,
      });
      if (!name) return;
      const info = await c.createVault(name);
      link = { ...link, vaultId: info.id, vaultName: info.name, role: info.role };
      await saveLink();
      await start({ seed: true });
      workspace.notify(`“${info.name}” is shared. Invite people from Settings → Collaboration.`);
    };

    const join = async (vaultId: string, vaultName: string, role: Role) => {
      if (vault.files().length > 0) {
        const ok = await workspace.confirm(
          'Joining works best with an empty folder: files already here would be added to the shared vault. Join anyway?',
          { confirmLabel: 'Join', danger: true },
        );
        if (!ok) return;
      }
      link = { ...link, vaultId, vaultName, role };
      await saveLink();
      await start({ seed: true });
      workspace.notify(`Joined “${vaultName}”. Files arrive in the background.`);
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
    ctx.commands.register({
      id: 'collab.share',
      title: 'Share this vault',
      category: 'Collaboration',
      when: () => !!link.token && !link.vaultId,
      run: share,
    });

    const settingsUi = ctx.tryUse(SettingsUi);
    if (!settingsUi) return;
    ctx.register(
      settingsUi.registerTab({
        id: 'collab',
        title: 'Collaboration',
        order: 40,
        render(container) {
          let email = link.user?.email ?? '';
          let codeSent = false;
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
            if (!link.token) {
              parts.push(
                settingItem(
                  'Server',
                  'Address of your Pumice server.',
                  textInput(
                    link.server,
                    (v) => ((link.server = v.trim() || DEFAULT_SERVER), void saveLink()),
                  ),
                ),
              );
              const emailInput = textInput(email, (v) => (email = v.trim()), {
                placeholder: 'you@example.com',
                label: 'Email',
              });
              parts.push(
                settingItem(
                  'Sign in',
                  'We email you a one-time code.',
                  h(
                    'div',
                    { class: 'pm-row-actions' },
                    emailInput,
                    button(
                      'Send code',
                      () =>
                        void run(async () => {
                          email = emailInput.value.trim();
                          const r = await accountClient().requestCode(email);
                          codeSent = true;
                          if (r.code)
                            workspace.notify(`Development server: your code is ${r.code}`, {
                              timeout: 15000,
                            });
                        }),
                    ),
                  ),
                ),
              );
              if (codeSent) {
                const codeInput = textInput('', () => undefined, {
                  placeholder: '123456',
                  label: 'Code',
                });
                const nameInput = textInput('', () => undefined, {
                  placeholder: 'Your name (new accounts)',
                  label: 'Name',
                });
                parts.push(
                  settingItem(
                    'Code',
                    `Sent to ${email}.`,
                    h(
                      'div',
                      { class: 'pm-row-actions' },
                      codeInput,
                      nameInput,
                      button(
                        'Sign in',
                        () =>
                          void run(async () => {
                            const c = accountClient();
                            const r = await c.verify(
                              email,
                              codeInput.value.trim(),
                              nameInput.value.trim() || undefined,
                              navigator.userAgent.slice(0, 80),
                            );
                            link = { ...link, token: r.token, user: r.user };
                            await saveLink();
                          }),
                        { kind: 'primary' },
                      ),
                    ),
                  ),
                );
              }
            } else {
              parts.push(
                settingItem(
                  `Signed in as ${link.user?.name ?? ''}`,
                  `${link.user?.email ?? ''} on ${link.server}`,
                  button(
                    'Sign out',
                    () =>
                      void run(async () => {
                        stop();
                        link = { server: link.server };
                        await saveLink();
                      }),
                  ),
                ),
              );
              if (!link.vaultId) {
                parts.push(
                  h('h3', {}, 'This vault'),
                  settingItem(
                    'Share this vault',
                    'Upload it to the server and invite others. Every note gets an ID.',
                    button('Share…', () => void run(share), { kind: 'primary' }),
                  ),
                );
                const inviteInput = textInput('', () => undefined, {
                  placeholder: 'Invite link or code',
                  label: 'Invite',
                });
                parts.push(
                  settingItem(
                    'Join with an invite',
                    'Paste the invite link someone sent you. Use an empty folder as the vault.',
                    h(
                      'div',
                      { class: 'pm-row-actions' },
                      inviteInput,
                      button(
                        'Join',
                        () =>
                          void run(async () => {
                            const token = inviteInput.value.trim().split('/').pop() ?? '';
                            const info = await accountClient().acceptInvite(token);
                            await join(info.id, info.name, info.role);
                          }),
                      ),
                    ),
                  ),
                );
                const list = h(
                  'div',
                  {},
                  h('p', { class: 'pm-setting-desc' }, 'Loading your shared vaults…'),
                );
                parts.push(h('h3', {}, 'Your shared vaults'), list);
                void accountClient()
                  .me()
                  .then(({ vaults }) => {
                    list.replaceChildren(
                      ...(vaults.length
                        ? vaults.map((v) =>
                            settingItem(
                              v.name,
                              `${v.role} · since ${new Date(v.createdAt).toLocaleDateString()}`,
                              button(
                                'Use this folder',
                                () => void run(() => join(v.id, v.name, v.role)),
                              ),
                            ),
                          )
                        : [h('p', { class: 'pm-setting-desc' }, 'None yet.')]),
                    );
                  })
                  .catch((e: Error) =>
                    list.replaceChildren(h('p', { class: 'pm-plugin-error' }, e.message)),
                  );
              } else {
                const state = client?.state ?? 'offline';
                parts.push(
                  h('h3', {}, 'This vault'),
                  settingItem(
                    link.vaultName ?? 'Shared vault',
                    `${state === 'online' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Offline — changes sync when the connection is back'} · your role: ${shared?.role ?? link.role}`,
                    button(
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
                if ((shared?.role ?? link.role) === 'owner') {
                  let inviteRole: Role = 'editor';
                  const out = h('div', { class: 'pm-setting-desc pm-invite-out' });
                  parts.push(
                    settingItem(
                      'Invite someone',
                      out,
                      h(
                        'div',
                        { class: 'pm-row-actions' },
                        select<Role>(
                          'editor',
                          [
                            ['editor', 'Can edit'],
                            ['viewer', 'Can view'],
                          ],
                          (r) => (inviteRole = r),
                          'Role',
                        ),
                        button(
                          'Create invite link',
                          () =>
                            void accountClient()
                              .invite(link.vaultId!, inviteRole)
                              .then((inv) => {
                                out.textContent = `Send this link (valid 7 days): ${inv.url.startsWith('/') ? `${link.server}${inv.url}` : inv.url}`;
                              })
                              .catch((e: Error) => (out.textContent = e.message)),
                        ),
                      ),
                    ),
                  );
                  const members = h('div', {});
                  parts.push(h('h3', {}, 'Members'), members);
                  void accountClient()
                    .members(link.vaultId!)
                    .then((list) =>
                      members.replaceChildren(
                        ...list.map((m) =>
                          settingItem(
                            m.user.name,
                            m.user.email,
                            m.user.id === link.user?.id
                              ? h('span', { class: 'pm-setting-desc' }, 'owner (you)')
                              : h(
                                  'div',
                                  { class: 'pm-row-actions' },
                                  select<Role>(
                                    m.role,
                                    [
                                      ['owner', 'Owner'],
                                      ['editor', 'Can edit'],
                                      ['viewer', 'Can view'],
                                    ],
                                    (r) =>
                                      void run(() =>
                                        accountClient().setRole(link.vaultId!, m.user.id, r),
                                      ),
                                    'Role',
                                  ),
                                  button(
                                    'Remove',
                                    () =>
                                      void run(() =>
                                        accountClient().removeMember(link.vaultId!, m.user.id),
                                      ),
                                    { kind: 'danger' },
                                  ),
                                ),
                          ),
                        ),
                      ),
                    )
                    .catch((e: Error) =>
                      members.replaceChildren(h('p', { class: 'pm-plugin-error' }, e.message)),
                    );
                }
              }
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
