import {
  PlatformService,
  Plugins,
  SettingsUi,
  Vault,
  Workspace,
  definePlugin,
  type PluginModule,
} from '@pumice/api';
import { button, h, settingItem, textInput, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { obsidianReport, reportMarkdown } from './obsidian';

export { obsidianReport, reportMarkdown } from './obsidian';
export const manifest = manifestJson;

export interface ErrorEntry {
  time: number;
  message: string;
  stack?: string;
  source: 'error' | 'rejection';
}

const MAX_ENTRIES = 50;

/** Strips anything that could be note content from a stack: keep frames only. */
export function scrubStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  return stack
    .split('\n')
    .filter((l) => /^\s+at\s|@/.test(l))
    .slice(0, 30)
    .map((l) => l.replace(/(blob|file|https?):\/\/[^\s)]+?\/([^/\s)]+:\d+:\d+)/g, '$2'))
    .join('\n');
}

export const plugin = definePlugin({
  async activate(ctx) {
    const workspace = ctx.use(Workspace);
    const vault = ctx.use(Vault);
    const platform = ctx.use(PlatformService);
    const plugins = ctx.use(Plugins);
    let log: ErrorEntry[] = [];
    try {
      log = JSON.parse((await ctx.storage.get('errors')) ?? '[]') as ErrorEntry[];
    } catch {
      log = [];
    }

    const report = async (entry: ErrorEntry) => {
      // Opt-in only, and only the error itself: no file names, no note content.
      if (!ctx.settings.get('send', false)) return;
      const endpoint = ctx.settings.get('endpoint', '');
      if (!/^https:\/\//.test(endpoint) && !/^http:\/\/localhost[:/]/.test(endpoint)) return;
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: entry.message.slice(0, 500),
          stack: scrubStack(entry.stack),
          os: platform.os,
          kind: platform.kind,
          plugins: plugins.list().map((p) => `${p.manifest.id}@${p.manifest.version}:${p.state}`),
          time: entry.time,
        }),
      }).catch(() => undefined);
    };

    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const record = (entry: ErrorEntry) => {
      log = [...log, entry].slice(-MAX_ENTRIES);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void ctx.storage.set('errors', JSON.stringify(log)), 1000);
      void report(entry);
    };
    const onError = (e: ErrorEvent) =>
      record({
        time: Date.now(),
        message: e.message || String(e.error),
        stack: (e.error as Error | undefined)?.stack,
        source: 'error',
      });
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as Error | undefined;
      record({
        time: Date.now(),
        message: reason?.message ?? String(e.reason),
        stack: reason?.stack,
        source: 'rejection',
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    ctx.register(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      clearTimeout(saveTimer);
    });

    ctx.commands.register({
      id: 'diagnostics.obsidian-report',
      title: 'Check Obsidian compatibility of this vault',
      category: 'Diagnostics',
      run: async () => {
        const entries = await platform.fs.list();
        const items = await obsidianReport({
          paths: entries.filter((e) => e.kind === 'file').map((e) => e.path),
          read: (p) => platform.fs.readText(p).catch(() => undefined),
        });
        const path = vault.availablePath('', 'Obsidian import report', 'md');
        await vault.create(path, reportMarkdown(items));
        await workspace.openFile(path);
      },
    });

    const settingsUi = ctx.tryUse(SettingsUi);
    if (!settingsUi) return;
    ctx.register(
      settingsUi.registerTab({
        id: 'diagnostics',
        title: 'Diagnostics',
        order: 90,
        render(container) {
          const render = () => {
            container.replaceChildren(
              h('h2', {}, 'Diagnostics'),
              settingItem(
                'Send crash reports',
                'Off by default. Reports contain the error message, a stack trace without file paths, your OS and plugin versions — never note names or content.',
                toggle(ctx.settings.get('send', false), (on) => void ctx.settings.set('send', on), {
                  label: 'Send crash reports',
                }),
              ),
              settingItem(
                'Report endpoint',
                'Where reports go, e.g. https://your-pumice-server/api/crash.',
                textInput(
                  ctx.settings.get('endpoint', ''),
                  (v) => void ctx.settings.set('endpoint', v.trim()),
                  { placeholder: 'https://…/api/crash' },
                ),
              ),
              settingItem(
                'Obsidian compatibility',
                'Writes a report note listing plugins and syntax from Obsidian that Pumice does or doesn’t support.',
                button(
                  'Create report',
                  () => void ctx.commands.execute('diagnostics.obsidian-report'),
                ),
              ),
              h('h3', {}, `Recent errors (${log.length})`),
              ...(log.length
                ? [...log]
                    .reverse()
                    .slice(0, 20)
                    .map((e) =>
                      h(
                        'details',
                        { class: 'pm-error-entry' },
                        h('summary', {}, `${new Date(e.time).toLocaleString()} — ${e.message}`),
                        h('pre', {}, scrubStack(e.stack) ?? ''),
                      ),
                    )
                : [h('p', { class: 'pm-setting-desc' }, 'No errors recorded.')]),
              h(
                'div',
                { class: 'pm-row-actions' },
                button(
                  'Copy report',
                  () =>
                    void navigator.clipboard?.writeText(
                      JSON.stringify(
                        {
                          os: platform.os,
                          kind: platform.kind,
                          plugins: plugins
                            .list()
                            .map(
                              (p) =>
                                `${p.manifest.id}@${p.manifest.version}:${p.state}${p.error ? ` (${p.error})` : ''}`,
                            ),
                          errors: log.map((e) => ({ ...e, stack: scrubStack(e.stack) })),
                        },
                        null,
                        2,
                      ),
                    ),
                ),
                button(
                  'Clear',
                  () => {
                    log = [];
                    void ctx.storage.set('errors', '[]');
                    render();
                  },
                  { kind: 'plain' },
                ),
              ),
            );
          };
          render();
        },
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
