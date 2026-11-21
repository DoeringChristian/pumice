import {
  SettingsUi,
  Templates,
  Vault,
  Workspace,
  definePlugin,
  formatDate,
  joinPath,
  newNoteContent,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { h, settingItem, textInput } from '@pumice/ui';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

/** Parses a date back from a file name written with `format` (digits-only tokens). */
export function parseDate(name: string, format: string): Date | undefined {
  const order: string[] = [];
  const pattern = format.replace(
    /\[([^\]]*)\]|YYYY|MM|DD|[.*+?^${}()|\\]/g,
    (m, literal: string | undefined) => {
      if (literal !== undefined) return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (m === 'YYYY') return (order.push('Y'), '(\\d{4})');
      if (m === 'MM') return (order.push('M'), '(\\d{2})');
      if (m === 'DD') return (order.push('D'), '(\\d{2})');
      return `\\${m}`;
    },
  );
  const match = new RegExp(`^${pattern}$`).exec(name);
  if (!match || order.length !== 3) return undefined;
  const get = (k: string) => Number(match[order.indexOf(k) + 1]);
  const d = new Date(get('Y'), get('M') - 1, get('D'));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * The template for daily notes. `setting` is what the user wrote: a path, with or without
 * `.md`, in any letter case, or just a template's name. With nothing set, a template called
 * "daily" in the templates folder is used.
 */
export function findTemplate(
  setting: string,
  files: readonly string[],
  templates: readonly string[],
): string | undefined {
  const wanted = setting
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/^\[\[|\]\]$/g, '');
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const name = (path: string) => path.split('/').pop()!.replace(/\.md$/i, '');
  if (!wanted) return templates.find((t) => same(name(t), 'daily'));
  const paths = [wanted, `${wanted}.md`];
  return (
    files.find((f) => paths.includes(f)) ??
    files.find((f) => paths.some((p) => same(f, p))) ??
    templates.find((t) => same(name(t), name(wanted)))
  );
}

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    const templates = ctx.use(Templates);
    // Lowercase by default; a vault that already has the folder we used to create keeps it.
    const folder = () => {
      const set = ctx.settings.get('folder', '');
      if (set) return set;
      return !vault.get('daily') && vault.get('Daily') ? 'Daily' : 'daily';
    };
    const format = () => ctx.settings.get('format', 'YYYY-MM-DD');
    const template = () => ctx.settings.get('template', '');

    const pathFor = (date: Date): VaultPath =>
      joinPath(folder(), `${formatDate(date, format())}.md`);

    const open = async (date: Date) => {
      const path = pathFor(date);
      if (!vault.get(path)) {
        const name = formatDate(date, format());
        const from = findTemplate(
          template(),
          vault
            .files()
            .filter((f) => f.extension === 'md')
            .map((f) => f.path),
          templates.list(),
        );
        if (from) await templates.createNote(from, path, { title: name, date });
        else {
          await vault.create(path, newNoteContent());
          if (template())
            workspace.notify(
              `The daily note template “${template()}” was not found; the note was created empty. Check the path in the settings.`,
              { kind: 'warning' },
            );
        }
      }
      await workspace.openFile(path);
    };

    const dailyNotes = () =>
      vault
        .files()
        .filter((f) => f.extension === 'md' && f.path.startsWith(`${folder()}/`))
        .map((f) => ({ path: f.path, date: parseDate(f.basename, format()) }))
        .filter((x): x is { path: VaultPath; date: Date } => !!x.date)
        .sort((a, b) => a.date.getTime() - b.date.getTime());

    const step = async (dir: -1 | 1) => {
      const current = workspace.activeFile;
      const notes = dailyNotes();
      const index = notes.findIndex((n) => n.path === current);
      if (index < 0) {
        workspace.notify('The active note is not a daily note.', { kind: 'warning' });
        return;
      }
      const next = notes[index + dir];
      if (next) await workspace.openFile(next.path);
      else workspace.notify(dir < 0 ? 'No earlier daily note.' : 'No later daily note.');
    };

    ctx.register(
      workspace.registerRibbonAction({
        id: 'daily.today',
        icon: 'calendar',
        title: "Open today's daily note",
        order: 20,
        run: () => ctx.commands.execute('daily.today'),
      }),
    );
    ctx.commands.register({
      id: 'daily.today',
      title: "Open today's daily note",
      category: 'Daily notes',
      run: () => open(new Date()),
    });
    ctx.commands.register({
      id: 'daily.yesterday',
      title: "Open yesterday's daily note",
      category: 'Daily notes',
      run: () => open(new Date(Date.now() - 86400000)),
    });
    ctx.commands.register({
      id: 'daily.previous',
      title: 'Previous daily note',
      category: 'Daily notes',
      run: () => step(-1),
    });
    ctx.commands.register({
      id: 'daily.next',
      title: 'Next daily note',
      category: 'Daily notes',
      run: () => step(1),
    });

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'daily',
          title: 'Daily notes',
          group: 'plugins',
          render(container) {
            const preview = h('span', {}, formatDate(new Date(), format()));
            container.replaceChildren(
              h('h2', {}, 'Daily notes'),
              settingItem(
                'Folder',
                'Where new daily notes are created.',
                textInput(folder(), (v) => void ctx.settings.set('folder', v.trim())),
              ),
              settingItem(
                'Date format',
                h('span', {}, 'File name, e.g. YYYY-MM-DD or YYYY/MM/YYYY-MM-DD. Today: ', preview),
                textInput(format(), (v) => {
                  void ctx.settings.set('format', v.trim() || 'YYYY-MM-DD');
                  preview.textContent = formatDate(new Date(), v.trim() || 'YYYY-MM-DD');
                }),
              ),
              settingItem(
                'Template',
                'A template note: its path or its name (optional). With nothing set, a template called “daily” in the templates folder is used.',
                textInput(template(), (v) => void ctx.settings.set('template', v.trim()), {
                  placeholder: 'templates/daily.md',
                }),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
