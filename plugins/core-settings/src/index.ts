import {
  PluginManager,
  Plugins,
  SettingsUi,
  Workspace,
  definePlugin,
  formatHotkey,
  toDisposable,
  type CommandsApi,
  type Disposable,
  type PluginInfo,
  type PluginManagerApi,
  type PluginModule,
  type PluginsApi,
  type SettingsTab,
  type WorkspaceApi,
} from '@pumice/api';
import { button, h, settingItem, textInput, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import './settings.css';

export const manifest = manifestJson;

function badge(p: PluginInfo): HTMLElement {
  const text =
    p.state === 'replaced'
      ? `replaced by ${p.replacedBy}`
      : p.state === 'disabled'
        ? 'off'
        : p.state;
  return h('span', { class: 'pm-badge', 'data-state': p.state }, text);
}

function pluginRow(
  p: PluginInfo,
  plugins: PluginsApi,
  rerender: () => void,
  extra: Node[] = [],
): HTMLElement {
  const on = p.state !== 'disabled';
  const required = plugins.isRequired(p.manifest.id);
  const desc = h(
    'div',
    {},
    p.manifest.description ?? '',
    h(
      'div',
      { class: 'pm-setting-meta' },
      `${p.manifest.id} · v${p.manifest.version}`,
      p.activationMs !== undefined ? ` · ${p.activationMs.toFixed(1)} ms` : '',
      ' ',
      badge(p),
    ),
    p.error ? h('div', { class: 'pm-plugin-error' }, p.error) : null,
  );
  const control = h(
    'div',
    { class: 'pm-row-actions' },
    ...extra,
    toggle(
      on,
      (checked) =>
        void plugins
          .setEnabled(p.manifest.id, checked)
          .catch((e: Error) => alertInline(control, e.message))
          .finally(rerender),
      { disabled: required, label: `${on ? 'Turn off' : 'Turn on'} ${p.manifest.name}` },
    ),
  );
  if (required) control.title = 'Required by the app';
  return settingItem(p.manifest.name, desc, control);
}

function alertInline(near: HTMLElement, message: string): void {
  near.parentElement?.append(h('div', { class: 'pm-plugin-error' }, message));
}

function corePluginsTab(plugins: PluginsApi): SettingsTab {
  return {
    id: 'core-plugins',
    title: 'Core plugins',
    order: 10,
    render(container) {
      const render = () => {
        const list = plugins.list().filter((p) => p.manifest.id.startsWith('core.'));
        const total = list.reduce((sum, p) => sum + (p.activationMs ?? 0), 0);
        container.replaceChildren(
          h('h2', {}, 'Core plugins'),
          h(
            'p',
            { class: 'pm-setting-desc' },
            `Everything in Pumice is a plugin. ${list.filter((p) => p.state === 'active').length} of ${list.length} active · startup activation ${total.toFixed(0)} ms.`,
          ),
          ...list.map((p) => pluginRow(p, plugins, render)),
        );
      };
      render();
    },
  };
}

function communityPluginsTab(
  plugins: PluginsApi,
  manager: PluginManagerApi | undefined,
  workspace: WorkspaceApi,
): SettingsTab {
  return {
    id: 'community-plugins',
    title: 'Community plugins',
    order: 20,
    render(container) {
      let status: HTMLElement;
      const run = async (label: string, task: () => Promise<unknown>) => {
        status.textContent = `${label}…`;
        status.className = 'pm-setting-desc';
        try {
          await task();
          status.textContent = '';
        } catch (e) {
          status.textContent = e instanceof Error ? e.message : String(e);
          status.className = 'pm-plugin-error';
        }
        render();
      };
      const render = () => {
        status = h('div', { class: 'pm-setting-desc' });
        if (!manager) {
          container.replaceChildren(
            h('h2', {}, 'Community plugins'),
            h('p', { class: 'pm-setting-desc' }, 'Not available in this app.'),
          );
          return;
        }
        const installed = manager.installed();
        const infos = new Map(plugins.list().map((p) => [p.manifest.id, p]));
        const url = textInput('', () => undefined, {
          placeholder: 'https://…/releases/download/1.0.0/',
          label: 'Plugin URL',
        });
        const files = h('input', {
          type: 'file',
          multiple: true,
          accept: '.js,.json,.css',
          class: 'pm-hidden-input',
          'aria-label': 'Plugin files',
        });
        files.addEventListener('change', () => {
          const chosen = [...(files.files ?? [])];
          void run('Installing', async () => {
            const read = async (name: string) => chosen.find((f) => f.name === name)?.text();
            const manifestText = await read('manifest.json');
            const main = await read('main.js');
            if (!manifestText || !main)
              throw new Error(
                'Select manifest.json and main.js (and styles.css if the plugin has one).',
              );
            const styles = await read('styles.css');
            const m = await manager.install({
              manifest: manifestText,
              main,
              ...(styles !== undefined ? { styles } : {}),
            });
            workspace.notify(`Installed ${m.name}.`);
          });
        });
        container.replaceChildren(
          h('h2', {}, 'Community plugins'),
          h(
            'p',
            { class: 'pm-setting-desc pm-warning' },
            'Plugins run with the same access as Pumice itself. Only install plugins you trust. Permissions in a plugin’s manifest prevent accidents, not malice.',
          ),
          settingItem(
            'Install from files',
            'Pick a plugin’s manifest.json, main.js and styles.css (as built by pumice-plugin build).',
            h(
              'div',
              {},
              files,
              button('Choose files…', () => files.click()),
            ),
          ),
          settingItem(
            'Install from URL',
            'A folder URL containing manifest.json, main.js and styles.css, for example a GitHub release.',
            h(
              'div',
              { class: 'pm-row-actions' },
              url,
              button(
                'Install',
                () => void run('Downloading', () => manager.installFromUrl(url.value.trim())),
                { kind: 'primary' },
              ),
            ),
          ),
          status,
          h('h3', {}, installed.length ? 'Installed' : 'No community plugins installed.'),
          ...installed.map((p) => {
            const info = infos.get(p.manifest.id) ?? {
              manifest: p.manifest,
              state: 'registered' as const,
            };
            return pluginRow(info, plugins, render, [
              button('Reload', () => void run('Reloading', () => manager.reload(p.manifest.id)), {
                kind: 'plain',
              }),
              button(
                'Uninstall',
                () =>
                  void workspace
                    .confirm(`Uninstall “${p.manifest.name}”? Its folder is moved to the trash.`, {
                      confirmLabel: 'Uninstall',
                      danger: true,
                    })
                    .then((ok) => {
                      if (ok) void run('Uninstalling', () => manager.uninstall(p.manifest.id));
                    }),
                { kind: 'danger' },
              ),
            ]);
          }),
        );
      };
      render();
      return manager?.onDidChange(render);
    },
  };
}

function hotkeysTab(commands: CommandsApi, isMac: boolean): SettingsTab {
  return {
    id: 'hotkeys',
    title: 'Hotkeys',
    order: 30,
    render(container) {
      const filter = textInput('', () => undefined, {
        placeholder: 'Filter commands…',
        label: 'Filter commands',
      });
      const list = h('div', {});
      const render = () => {
        const q = filter.value.toLowerCase();
        list.replaceChildren(
          ...commands
            .list()
            .filter((c) => !q || `${c.category ?? ''} ${c.title}`.toLowerCase().includes(q))
            .sort((a, b) => `${a.category}${a.title}`.localeCompare(`${b.category}${b.title}`))
            .map((c) =>
              settingItem(
                c.category ? `${c.category}: ${c.title}` : c.title,
                c.id,
                h(
                  'span',
                  { class: 'pm-hotkeys' },
                  ...(c.hotkeys.length
                    ? c.hotkeys.map((k) => h('kbd', {}, formatHotkey(k, isMac)))
                    : [h('span', { class: 'pm-setting-desc' }, '—')]),
                ),
              ),
            ),
        );
      };
      filter.addEventListener('input', render);
      container.replaceChildren(h('h2', {}, 'Hotkeys'), filter, list);
      render();
    },
  };
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const plugins = ctx.use(Plugins);
    const tabs: SettingsTab[] = [];
    const views = new Set<() => void>();
    let requested: string | undefined;

    const api = {
      registerTab(tab: SettingsTab): Disposable {
        tabs.push(tab);
        for (const refresh of views) refresh();
        return toDisposable(() => {
          tabs.splice(tabs.indexOf(tab) >>> 0, 1);
          for (const refresh of views) refresh();
        });
      },
      async open(tabId?: string) {
        requested = tabId;
        await workspace.openView('settings', { newTab: true, state: tabId ? { tab: tabId } : {} });
      },
    };
    ctx.provide(SettingsUi, api);
    ctx.register(api.registerTab(corePluginsTab(plugins)));
    ctx.register(
      api.registerTab(communityPluginsTab(plugins, ctx.tryUse(PluginManager), workspace)),
    );
    ctx.register(
      api.registerTab(
        hotkeysTab(ctx.commands, ctx.platform.os === 'macos' || ctx.platform.os === 'ios'),
      ),
    );

    ctx.register(
      workspace.registerView({
        type: 'settings',
        title: 'Settings',
        icon: 'settings',
        create(viewCtx, state) {
          viewCtx.setTitle('Settings');
          const nav = h('nav', { class: 'pm-settings-nav', 'aria-label': 'Settings sections' });
          const content = h('div', { class: 'pm-settings-content' });
          viewCtx.container.append(h('div', { class: 'pm-settings' }, nav, content));
          let current =
            (state.tab as string | undefined) ?? requested ?? ctx.settings.get('lastTab', '');
          let disposeTab: (() => void) | undefined;
          const sorted = () =>
            [...tabs].sort((a, b) => {
              const g = (t: SettingsTab) => (t.group === 'plugins' ? 1 : 0);
              return (
                g(a) - g(b) || (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title)
              );
            });
          const show = (id: string) => {
            const list = sorted();
            const tab = list.find((t) => t.id === id) ?? list[0];
            if (!tab) return;
            current = tab.id;
            void ctx.settings.set('lastTab', current);
            disposeTab?.();
            disposeTab = undefined;
            content.replaceChildren();
            const panel = h('div', { class: 'pm-settings-panel' });
            content.append(panel);
            try {
              const result = tab.render(panel);
              if (typeof result === 'function') disposeTab = result;
              else if (result && 'dispose' in result) disposeTab = () => result.dispose();
            } catch (e) {
              panel.append(
                h(
                  'div',
                  { class: 'pm-plugin-error' },
                  `This tab failed to render: ${e instanceof Error ? e.message : String(e)}`,
                ),
              );
            }
            renderNav();
          };
          const renderNav = () => {
            const list = sorted();
            let lastGroup: string | undefined;
            nav.replaceChildren();
            for (const tab of list) {
              const group = tab.group === 'plugins' ? 'Plugin options' : 'Options';
              if (group !== lastGroup) nav.append(h('div', { class: 'pm-settings-group' }, group));
              lastGroup = group;
              nav.append(
                h(
                  'button',
                  {
                    class: `pm-settings-tab${tab.id === current ? ' is-active' : ''}`,
                    onclick: () => show(tab.id),
                    'aria-current': tab.id === current ? 'page' : undefined,
                  },
                  tab.title,
                ),
              );
            }
          };
          const refresh = () => (tabs.some((t) => t.id === current) ? renderNav() : show(current));
          views.add(refresh);
          show(current);
          return {
            setState(s) {
              if (typeof s.tab === 'string') show(s.tab);
            },
            getState: () => ({ tab: current }),
            dispose() {
              views.delete(refresh);
              disposeTab?.();
            },
          };
        },
      }),
    );
    ctx.commands.register({
      id: 'settings.open',
      title: 'Open settings',
      category: 'App',
      hotkeys: ['Mod+,'],
      run: (tab?: unknown) => api.open(typeof tab === 'string' ? tab : undefined),
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
