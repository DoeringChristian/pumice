import {
  dirname,
  joinPath,
  type MenuEntry,
  type PluginSettings,
  type VaultApi,
  type VaultEntry,
  type WorkspaceApi,
} from '@pumice/api';
import { Icon } from '@pumice/core-workspace';
import { useCallback, useEffect, useState } from 'react';

interface Actions {
  newNote(folder: string): void;
  rename(entry: VaultEntry): void;
  remove(entry: VaultEntry): void;
}

interface Props {
  vault: VaultApi;
  workspace: WorkspaceApi;
  settings: PluginSettings;
  actions: Actions;
}

const DRAG_TYPE = 'application/x-pumice-path';

function displayName(entry: VaultEntry): string {
  return entry.kind === 'file' && entry.extension === 'md' ? entry.name.slice(0, -3) : entry.name;
}

function useRerender(subscribe: (cb: () => void) => { dispose(): void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const d = subscribe(() => setTick((t) => t + 1));
    return () => d.dispose();
  }, [subscribe]);
}

export function Explorer({ vault, workspace, settings, actions }: Props) {
  useRerender(useCallback((cb) => vault.onDidChange(cb), [vault]));
  useRerender(useCallback((cb) => workspace.onDidChangeActiveFile(cb), [workspace]));
  const [expanded, setExpanded] = useState(() => new Set(settings.get<string[]>('expanded', [])));
  const [dropTarget, setDropTarget] = useState<string | undefined>();
  const active = workspace.activeFile;

  const persist = (next: Set<string>) => {
    setExpanded(next);
    void settings.set('expanded', [...next]);
  };

  // Reveal the active file.
  useEffect(() => {
    if (!active) return;
    const missing: string[] = [];
    for (let dir = dirname(active); dir !== ''; dir = dirname(dir))
      if (!expanded.has(dir)) missing.push(dir);
    if (missing.length) persist(new Set([...expanded, ...missing]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    persist(next);
  };

  const move = async (from: string, folder: string) => {
    if (from === folder || folder.startsWith(from + '/') || dirname(from) === folder) return;
    const name = from.slice(from.lastIndexOf('/') + 1);
    try {
      await vault.rename(from, joinPath(folder, name));
    } catch (e) {
      workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' });
    }
  };

  const menuFor = (entry: VaultEntry): MenuEntry[] => {
    const folder = entry.kind === 'folder' ? entry.path : dirname(entry.path);
    const items: MenuEntry[] = [];
    if (entry.kind === 'file') {
      items.push({
        label: 'Open in new tab',
        icon: 'file',
        run: () => workspace.openFile(entry.path, { newTab: true }),
      });
      items.push('separator');
    }
    items.push(
      { label: 'New note', icon: 'file-plus', run: () => actions.newNote(folder) },
      {
        label: 'New folder',
        icon: 'folder-plus',
        run: async () => {
          const name = await workspace.showPrompt({ title: 'New folder', value: 'Untitled' });
          if (name?.trim()) {
            await vault.createFolder(joinPath(folder, name.trim()));
            persist(new Set([...expanded, folder]));
          }
        },
      },
      'separator',
      { label: 'Rename…', icon: 'pencil', run: () => actions.rename(entry) },
      { label: 'Delete', icon: 'trash', danger: true, run: () => actions.remove(entry) },
    );
    return items;
  };

  const renderEntries = (folder: string, depth: number): React.ReactNode =>
    vault.children(folder).map((entry) => {
      const isFolder = entry.kind === 'folder';
      const open = isFolder && expanded.has(entry.path);
      return (
        <li key={entry.path} role="treeitem" aria-expanded={isFolder ? open : undefined}>
          <button
            className="pm-tree-row"
            data-path={entry.path}
            data-folder={isFolder || undefined}
            aria-label={displayName(entry)}
            data-active={entry.path === active}
            data-drop={dropTarget === entry.path}
            style={{ paddingLeft: 8 + depth * 14 }}
            draggable
            title={entry.path}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, entry.path);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setDropTarget(isFolder ? entry.path : dirname(entry.path) || '/');
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(undefined);
              const from = e.dataTransfer.getData(DRAG_TYPE);
              if (from) void move(from, isFolder ? entry.path : dirname(entry.path));
            }}
            onClick={(e) => {
              if (isFolder) toggle(entry.path);
              else void workspace.openFile(entry.path, { newTab: e.metaKey || e.ctrlKey });
            }}
            onAuxClick={(e) => {
              if (e.button === 1 && !isFolder)
                void workspace.openFile(entry.path, { newTab: true });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              workspace.showContextMenu(menuFor(entry), { x: e.clientX, y: e.clientY });
            }}
          >
            {isFolder ? (
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
            ) : (
              <span className="pm-tree-spacer" />
            )}
            <span className="pm-tree-name">{displayName(entry)}</span>
            {entry.kind === 'file' && entry.extension !== 'md' && (
              <span className="pm-tree-ext">{entry.extension.toUpperCase()}</span>
            )}
          </button>
          {open && <ul role="group">{renderEntries(entry.path, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <div className="pm-explorer">
      <div className="pm-explorer-actions">
        <button
          className="pm-icon-button"
          title="New note"
          aria-label="New note"
          onClick={() => actions.newNote('')}
        >
          <Icon name="file-plus" />
        </button>
        <button
          className="pm-icon-button"
          title="New folder"
          aria-label="New folder"
          onClick={async () => {
            const name = await workspace.showPrompt({ title: 'New folder', value: 'Untitled' });
            if (name?.trim()) await vault.createFolder(name.trim());
          }}
        >
          <Icon name="folder-plus" />
        </button>
        <button
          className="pm-icon-button"
          title="Collapse all"
          aria-label="Collapse all"
          onClick={() => persist(new Set())}
        >
          <Icon name="chevron-right" />
        </button>
      </div>
      <ul
        className="pm-tree"
        role="tree"
        aria-label="Files"
        onKeyDown={(e) => {
          // Arrow-key navigation over the visible rows (WAI-ARIA tree pattern).
          const rows = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.pm-tree-row'),
          ];
          const i = rows.indexOf(document.activeElement as HTMLButtonElement);
          if (i < 0) return;
          const row = rows[i]!;
          const path = row.dataset.path!;
          const folder = row.dataset.folder !== undefined;
          let next: HTMLButtonElement | undefined;
          if (e.key === 'ArrowDown') next = rows[i + 1];
          else if (e.key === 'ArrowUp') next = rows[i - 1];
          else if (e.key === 'Home') next = rows[0];
          else if (e.key === 'End') next = rows[rows.length - 1];
          else if (e.key === 'ArrowRight' && folder) {
            if (!expanded.has(path)) toggle(path);
            else next = rows[i + 1];
          } else if (e.key === 'ArrowLeft') {
            if (folder && expanded.has(path)) toggle(path);
            else next = rows.find((r) => r.dataset.path === dirname(path));
          } else return;
          e.preventDefault();
          next?.focus();
        }}
        data-drop={dropTarget === '/'}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setDropTarget('/');
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(undefined);
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (from) void move(from, '');
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          workspace.showContextMenu(
            [
              { label: 'New note', icon: 'file-plus', run: () => actions.newNote('') },
              {
                label: 'New folder',
                icon: 'folder-plus',
                run: async () => {
                  const name = await workspace.showPrompt({
                    title: 'New folder',
                    value: 'Untitled',
                  });
                  if (name?.trim()) await vault.createFolder(name.trim());
                },
              },
            ],
            { x: e.clientX, y: e.clientY },
          );
        }}
      >
        {renderEntries('', 0)}
        {vault.children('').length === 0 && <li className="pm-tree-empty">This vault is empty.</li>}
      </ul>
    </div>
  );
}
