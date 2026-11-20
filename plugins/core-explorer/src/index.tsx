import {
  Vault,
  Workspace,
  basename,
  definePlugin,
  dirname,
  joinPath,
  type PluginModule,
  type VaultApi,
  type VaultEntry,
  type WorkspaceApi,
  newNoteContent,
} from '@pumice/api';
import { createRoot } from 'react-dom/client';
import manifestJson from '../manifest.json';
import { Explorer } from './explorer';
import './explorer.css';

export const manifest = manifestJson;

/** Folder for new notes: the active file's folder, or the vault root. */
function targetFolder(vault: VaultApi, workspace: WorkspaceApi, location: string): string {
  if (location === 'root') return '';
  const active = workspace.activeFile;
  return active && vault.get(active) ? dirname(active) : '';
}

export async function createNote(
  vault: VaultApi,
  workspace: WorkspaceApi,
  folder: string,
  name = 'Untitled',
) {
  const path = vault.availablePath(folder, name, 'md');
  // Notes created in Pumice get their identity right away (docs/plan/04).
  await vault.create(path, newNoteContent());
  await workspace.openFile(path, { state: { rename: true } });
  return path;
}

export async function renameEntry(vault: VaultApi, workspace: WorkspaceApi, entry: VaultEntry) {
  const isMd = entry.kind === 'file' && entry.extension === 'md';
  const current = isMd ? entry.name.slice(0, -3) : entry.name;
  const dot = entry.kind === 'file' ? current.lastIndexOf('.') : -1;
  const value = await workspace.showPrompt({
    title: `Rename ${entry.kind}`,
    value: current,
    selection: [0, dot > 0 ? dot : current.length],
  });
  if (!value || value.trim() === current) return;
  const name = isMd ? `${value.trim()}.md` : value.trim();
  try {
    await vault.rename(entry.path, joinPath(dirname(entry.path), name));
  } catch (e) {
    workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' });
  }
}

export async function deleteEntry(vault: VaultApi, workspace: WorkspaceApi, entry: VaultEntry) {
  const what =
    entry.kind === 'folder' ? `the folder “${entry.name}” and everything in it` : `“${entry.name}”`;
  const ok = await workspace.confirm(`Delete ${what}? It is moved to the system trash.`, {
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await vault.delete(entry.path);
  } catch (e) {
    workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' });
  }
}

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    const newNoteLocation = () =>
      ctx.settings.get<'current' | 'root'>('newNoteLocation', 'current');

    ctx.register(
      workspace.registerView({
        type: 'file-explorer',
        title: 'Files',
        icon: 'folder',
        create(viewCtx) {
          const root = createRoot(viewCtx.container);
          root.render(
            <Explorer
              vault={vault}
              workspace={workspace}
              settings={ctx.settings}
              actions={{
                newNote: (folder) => void createNote(vault, workspace, folder),
                rename: (entry) => void renameEntry(vault, workspace, entry),
                remove: (entry) => void deleteEntry(vault, workspace, entry),
              }}
            />,
          );
          return { dispose: () => root.unmount() };
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'explorer',
        side: 'left',
        viewType: 'file-explorer',
        title: 'Files',
        icon: 'folder',
        order: 0,
      }),
    );

    ctx.register(
      workspace.registerRibbonAction({
        id: 'explorer.new-note',
        icon: 'file-plus',
        title: 'New note',
        order: 10,
        run: () => ctx.commands.execute('explorer.new-note'),
      }),
    );
    ctx.commands.register({
      id: 'explorer.new-note',
      title: 'Create new note',
      category: 'Files',
      hotkeys: ['Mod+N'],
      run: () => createNote(vault, workspace, targetFolder(vault, workspace, newNoteLocation())),
    });
    ctx.commands.register({
      id: 'explorer.new-folder',
      title: 'Create new folder',
      category: 'Files',
      run: async () => {
        const name = await workspace.showPrompt({ title: 'New folder', value: 'Untitled' });
        if (!name?.trim()) return;
        const parent = targetFolder(vault, workspace, newNoteLocation());
        await vault.createFolder(joinPath(parent, name.trim()));
      },
    });
    const activeEntry = () => (workspace.activeFile ? vault.get(workspace.activeFile) : undefined);
    ctx.commands.register({
      id: 'explorer.rename-file',
      title: 'Rename current file',
      category: 'Files',
      hotkeys: ['F2'],
      when: () => !!activeEntry(),
      run: () => renameEntry(vault, workspace, activeEntry()!),
    });
    ctx.commands.register({
      id: 'explorer.delete-file',
      title: 'Delete current file',
      category: 'Files',
      when: () => !!activeEntry(),
      run: () => deleteEntry(vault, workspace, activeEntry()!),
    });
    ctx.commands.register({
      id: 'explorer.reveal-active-file',
      title: 'Reveal current file in navigation',
      category: 'Files',
      when: () => !!workspace.activeFile,
      run: () => workspace.openView('file-explorer', { location: 'left' }),
    });
    ctx.commands.register({
      id: 'explorer.reload-vault',
      title: 'Reload files from disk',
      category: 'Files',
      run: async () => {
        await vault.rescan();
        workspace.notify(`Reloaded ${basename(vault.name)}`, { timeout: 1500 });
      },
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
