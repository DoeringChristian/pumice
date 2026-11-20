import {
  Documents,
  Editor,
  MarkdownSyntax,
  SettingsUi,
  Templates,
  Vault,
  Workspace,
  definePlugin,
  dirname,
  frontmatterBounds,
  markdownText,
  updateFrontmatter,
  type PluginModule,
  type TemplatesApi,
  type VaultPath,
} from '@pumice/api';
import manifestJson from '../manifest.json';
import { renderTemplate } from './render';

export { formatDate, renderTemplate } from './render';
export const manifest = manifestJson;

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    const editor = ctx.use(Editor);
    const documents = ctx.use(Documents);
    const syntax = ctx.use(MarkdownSyntax);
    const folder = () => ctx.settings.get('folder', 'Templates').replace(/\/+$/, '');

    const api: TemplatesApi = {
      list: () =>
        vault
          .files()
          .filter((f) => f.extension === 'md' && f.path.startsWith(`${folder()}/`))
          .map((f) => f.path)
          .sort(),
      async render(templatePath, vars = {}) {
        return renderTemplate(await documents.read(templatePath), vars);
      },
      async createNote(templatePath, path, vars = {}) {
        const title = vars.title ?? path.split('/').pop()!.replace(/\.md$/i, '');
        const text = await api.render(templatePath, { ...vars, title });
        await vault.create(path, text);
        return path;
      },
    };
    ctx.provide(Templates, api);

    const pick = async () => {
      const templates = api.list();
      if (!templates.length) {
        workspace.notify(
          `No templates yet. Put notes in the “${folder()}” folder (or change it in settings).`,
          { kind: 'warning' },
        );
        return undefined;
      }
      const choice = await workspace.showQuickPick({
        placeholder: 'Choose a template…',
        items: templates.map((path) => ({
          label: path.slice(folder().length + 1).replace(/\.md$/, ''),
          detail: path,
          path,
        })),
      });
      return choice?.path;
    };

    ctx.register(
      workspace.registerRibbonAction({
        id: 'templates.insert',
        icon: 'layout-template',
        title: 'Insert template',
        order: 70,
        run: () => ctx.commands.execute('templates.insert'),
      }),
    );
    ctx.commands.register({
      id: 'templates.insert',
      title: 'Insert template',
      category: 'Templates',
      when: () => !!editor.active(),
      run: async () => {
        const target = editor.active();
        const path = await pick();
        if (!target || !path) return;
        const title = target.path.split('/').pop()!.replace(/\.md$/i, '');
        const rendered = await api.render(path, { title });
        const fm = frontmatterBounds(rendered);
        const body = fm ? rendered.slice(fm.to) : rendered;
        // Template properties are merged into the note's frontmatter; the body goes at the cursor.
        editor.insertAtCursor(body);
        const props = fm ? syntax.extract(rendered).frontmatter : undefined;
        if (props && Object.keys(props).length) {
          const handle = await documents.open(target.path);
          try {
            const ytext = markdownText(handle.doc);
            const change = updateFrontmatter(ytext.toString(), (doc) => {
              for (const [key, value] of Object.entries(props))
                if (!doc.has(key)) doc.set(key, value);
            });
            if (change) {
              handle.doc.transact(() => {
                ytext.delete(change.from, change.to - change.from);
                ytext.insert(change.from, change.insert);
              });
            }
          } finally {
            handle.dispose();
          }
        }
      },
    });

    ctx.commands.register({
      id: 'templates.new-note',
      title: 'Create new note from template',
      category: 'Templates',
      run: async () => {
        const templatePath = await pick();
        if (!templatePath) return;
        const name = await workspace.showPrompt({ title: 'Note name', value: 'Untitled' });
        if (!name?.trim()) return;
        const active = workspace.activeFile;
        const target = vault.availablePath(active ? dirname(active) : '', name.trim(), 'md');
        await workspace.openFile(await api.createNote(templatePath, target as VaultPath));
      },
    });

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'templates',
          title: 'Templates',
          group: 'plugins',
          render(container) {
            const input = document.createElement('input');
            input.className = 'pm-text-input';
            input.value = folder();
            input.setAttribute('aria-label', 'Template folder');
            input.addEventListener(
              'change',
              () => void ctx.settings.set('folder', input.value.trim() || 'Templates'),
            );
            const row = document.createElement('div');
            row.className = 'pm-setting';
            row.innerHTML =
              '<div class="pm-setting-info"><div class="pm-setting-name">Template folder</div><div class="pm-setting-desc">Notes in this folder are offered as templates. Variables: {{title}}, {{date}}, {{time}}, {{date:YYYY-MM-DD}}.</div></div>';
            row.append(input);
            const h2 = document.createElement('h2');
            h2.textContent = 'Templates';
            container.replaceChildren(h2, row);
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
