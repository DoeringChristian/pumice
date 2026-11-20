import { EditorView } from '@codemirror/view';
import {
  Editor,
  FileLocations,
  Frames,
  Links,
  Reader,
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

/** The https address of a picture in a drag from a web page, if that is what it carries. */
export function pictureAddress(data: DataTransfer | null | undefined): string | undefined {
  if (!data) return undefined;
  const fromHtml = /<img[^>]+src=["'](https:\/\/[^"']+)["']/i.exec(data.getData('text/html'))?.[1];
  const listed = data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .find((l) => l && !l.startsWith('#'));
  const address = fromHtml?.replace(/&amp;/g, '&') ?? listed;
  if (!address || !/^https:\/\//i.test(address)) return undefined;
  // From the page's own picture element, or an address that names a picture.
  return fromHtml || /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|#|$)/i.test(address)
    ? address
    : undefined;
}

/** What the file list puts on a drag: the vault path. */
const VAULT_DRAG = 'application/x-pumice-path';
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
    const platform = ctx.use(PlatformService);
    const fs = platform.fs;

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
      let text = links.join('\n');
      const range = at === undefined ? view.state.selection.main : { from: at, to: at };
      // Dropped at the end of a line that has text: the file gets lines of its own.
      const line = view.state.doc.lineAt(range.from);
      if (at !== undefined && at === line.to && line.text.trim()) text = `\n\n${text}\n`;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        userEvent: 'input.paste',
      });
      view.focus();
    };
    /**
     * Files of the vault dropped into a note (from the file list): a picture is embedded, a
     * note is linked, and a file that a frame can show becomes a block for that frame.
     */
    const addVaultFiles = async (
      view: EditorView,
      source: VaultPath,
      paths: VaultPath[],
      at?: number,
    ) => {
      let text = await ctx.tryUse(Frames)?.insertionFor(paths, source);
      if (text === null) return;
      let block = text !== undefined;
      if (text === undefined) {
        const links = ctx.tryUse(Links);
        const reader = ctx.tryUse(Reader);
        const parts = paths
          .filter((p) => vault.get(p)?.kind === 'file')
          .map((p) => {
            // As when writing by hand: notes are linked, what can be shown is embedded.
            const isNote = /\.md$/i.test(p) && !/\.excalidraw\.md$/i.test(p);
            const embed = !isNote && !!reader?.canEmbed(p);
            let link: string;
            try {
              link = links?.formatLink(p, { embed }) ?? `${embed ? '!' : ''}[[${p}]]`;
            } catch {
              link = `${embed ? '!' : ''}[[${p}]]`;
            }
            block ||= embed;
            return link;
          });
        if (!parts.length) return;
        text = parts.join(block ? '\n\n' : ' ');
      }
      const pos = at ?? view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      // Dropped on a line of embeds: it joins them, so they stand beside each other.
      if (/^!\[\[[^\]\n]*\]\]$/.test(text) && /^\s*(!\[\[[^\]]*\]\]\s*)+$/.test(line.text)) {
        const insert = ` ${text}`;
        view.dispatch({
          changes: { from: line.to, insert },
          selection: { anchor: line.to + insert.length },
          userEvent: 'input.drop',
        });
        view.focus();
        return;
      }
      // Something shown as a block goes on lines of its own.
      const insert = block ? `${line.text.trim() ? '\n\n' : ''}${text}\n` : text;
      const from = block ? (line.text.trim() ? line.to : line.from) : pos;
      view.dispatch({
        changes: { from, to: block ? line.to : pos, insert },
        selection: { anchor: from + insert.length },
        userEvent: 'input.drop',
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
            dragover(event) {
              // A file from the file list may be dropped here.
              if (!event.dataTransfer?.types.includes(VAULT_DRAG)) return false;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              return true;
            },
            drop(event, view) {
              const source = ectx.path();
              const dragged = event.dataTransfer?.getData(VAULT_DRAG);
              if (dragged && source !== undefined && !view.state.readOnly) {
                event.preventDefault();
                const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined;
                void addVaultFiles(view, source, [dragged], at).catch(report);
                return true;
              }
              const files = [...(event.dataTransfer?.files ?? [])];
              if (source === undefined || view.state.readOnly) return false;
              const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined;
              if (files.length) {
                event.preventDefault();
                void addFiles(view, source, files, at).catch(report);
                return true;
              }
              // A picture dragged out of a web page arrives as its address: fetch it into the
              // attachments, so the note does not depend on the website.
              const address = pictureAddress(event.dataTransfer);
              const fetchBinary = platform.net?.fetchBinary;
              if (!address || !fetchBinary) return false;
              event.preventDefault();
              void (async () => {
                const bytes = await fetchBinary(address);
                const name = decodeURIComponent(
                  new URL(address).pathname.split('/').pop() || 'image',
                );
                const file = new File(
                  [bytes as BlobPart],
                  /\.[a-z0-9]+$/i.test(name) ? name : `${name}.png`,
                );
                await addFiles(view, source, [file], at);
              })().catch(report);
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
