import { EditorView } from '@codemirror/view';
import {
  Editor,
  FileLocations,
  PlatformService,
  SettingsUi,
  Vault,
  Workspace,
  definePlugin,
  type FolderRule,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { h, select, settingItem, textInput } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { DEFAULT_RULE, FileLocationsImpl, attachmentName, ruleFromObsidian } from './locations';

export const manifest = manifestJson;
export { FileLocationsImpl, folderFor, ruleFromObsidian } from './locations';

const MODES: Array<[FolderRule['mode'], string]> = [
  ['root', 'Vault folder'],
  ['folder', 'In the folder specified below'],
  ['same', 'Same folder as the current note'],
  ['subfolder', 'In a subfolder next to the current note'],
];

export const plugin = definePlugin({
  async activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    const fs = ctx.use(PlatformService).fs;

    // Until the user chooses, follow what Obsidian is set to in this vault, if it is one.
    const obsidian: { attachments?: FolderRule; drawings?: FolderRule } = {};
    const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        if (!(await fs.stat(path))) return undefined;
        return JSON.parse(await fs.readText(path)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };
    const app = await readJson('.obsidian/app.json');
    const fromApp = ruleFromObsidian(app?.attachmentFolderPath);
    if (fromApp) obsidian.attachments = fromApp;
    const excalidraw = await readJson('.obsidian/plugins/obsidian-excalidraw-plugin/data.json');
    if (typeof excalidraw?.folder === 'string' && excalidraw.folder.trim())
      obsidian.drawings = { mode: 'folder', folder: excalidraw.folder.trim() };

    const rule = (key: 'attachments' | 'drawings'): FolderRule =>
      ctx.settings.get<FolderRule | undefined>(key, undefined) ?? obsidian[key] ?? DEFAULT_RULE;
    const locations = new FileLocationsImpl(vault, {
      attachments: () => rule('attachments'),
      drawings: () => rule('drawings'),
    });
    ctx.provide(FileLocations, locations);

    // ---- Adding files to a note: paste or drop them into the editor ---------------------------

    const addFiles = async (view: EditorView, source: VaultPath, files: File[], at?: number) => {
      const links: string[] = [];
      for (const file of files) {
        const { base, extension } = attachmentName(file);
        const path = locations.attachmentPath(source, base, extension);
        await vault.create(path, new Uint8Array(await file.arrayBuffer()));
        // Obsidian's form: the file name, with the path only when the name isn't unique.
        const name = path.split('/').pop()!;
        const clash = vault
          .files()
          .some((f) => f.path !== path && f.path.split('/').pop() === name);
        links.push(`![[${clash ? path : name}]]`);
      }
      if (!links.length) return;
      const text = links.join('\n');
      const range = at === undefined ? view.state.selection.main : { from: at, to: at };
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        userEvent: 'input.paste',
      });
      view.focus();
    };
    const report = (e: unknown) =>
      workspace.notify(`Could not add the file: ${e instanceof Error ? e.message : String(e)}`, {
        kind: 'error',
      });

    const editor = ctx.tryUse(Editor);
    if (editor) {
      ctx.register(
        editor.registerExtension((ectx) =>
          EditorView.domEventHandlers({
            paste(event, view) {
              const source = ectx.path();
              const files = [...(event.clipboardData?.files ?? [])];
              // Text copied together with a picture (from a web page, say) pastes as text.
              if (!files.length || source === undefined || view.state.readOnly) return false;
              if (event.clipboardData?.getData('text/plain')) return false;
              event.preventDefault();
              void addFiles(view, source, files).catch(report);
              return true;
            },
            drop(event, view) {
              const source = ectx.path();
              const files = [...(event.dataTransfer?.files ?? [])];
              if (!files.length || source === undefined || view.state.readOnly) return false;
              event.preventDefault();
              const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined;
              void addFiles(view, source, files, at).catch(report);
              return true;
            },
          }),
        ),
      );
    }

    // ---- Settings -----------------------------------------------------------------------------

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      const rows = (
        key: 'attachments' | 'drawings',
        title: string,
        what: string,
        example: string,
      ) => {
        const current = rule(key);
        const folder = textInput(current.folder, (v) => void save({ folder: v.trim() }));
        folder.placeholder = example;
        const sync = (mode: FolderRule['mode']) => {
          folder.disabled = mode === 'root' || mode === 'same';
        };
        const save = (patch: Partial<FolderRule>) => {
          const next = { ...rule(key), ...patch };
          sync(next.mode);
          return ctx.settings.set(key, next);
        };
        sync(current.mode);
        return [
          settingItem(
            title,
            `Where ${what} are put.`,
            select(current.mode, MODES, (mode) => void save({ mode }), title),
          ),
          settingItem(
            'Folder',
            'A path in the vault for "In the folder specified below", or a folder name for the subfolder option.',
            folder,
          ),
        ];
      };
      ctx.register(
        settingsUi.registerTab({
          id: 'files',
          title: 'Files',
          group: 'app',
          order: 20,
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Files'),
              ...(obsidian.attachments || obsidian.drawings
                ? [
                    h(
                      'p',
                      { class: 'pm-setting-note' },
                      'Until you change them, these follow this vault’s Obsidian settings.',
                    ),
                  ]
                : []),
              h('h3', {}, 'Attachments'),
              ...rows(
                'attachments',
                'Default location for new attachments',
                'images and files you paste or drop into a note',
                'e.g. assets',
              ),
              h('h3', {}, 'Drawings'),
              ...rows(
                'drawings',
                'Default location for new drawings',
                'new Excalidraw drawings',
                'e.g. drawings',
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
