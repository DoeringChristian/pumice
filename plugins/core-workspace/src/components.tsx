import type { MenuEntry, QuickPickItem } from '@pumice/api';
import { createIcon, fuzzyFilter, fuzzyMatch } from '@pumice/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Leaf, Overlay, WorkspaceModel } from './model';

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(createIcon(name, size));
  }, [name, size]);
  return <span className="pm-icon" ref={ref} />;
}

function useModel(model: WorkspaceModel): number {
  return useSyncExternalStore(
    (onChange) => {
      const d = model.onDidChange(onChange);
      return () => d.dispose();
    },
    () => model.version,
  );
}

/** Re-parents a leaf's stable container element. */
function LeafHost({ leaf, visible }: { leaf: Leaf; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.appendChild(leaf.container);
  }, [leaf]);
  return <div className="pm-leaf" ref={ref} hidden={!visible} />;
}

export function WorkspaceRoot({ model, vaultName }: { model: WorkspaceModel; vaultName: string }) {
  useModel(model);
  const left = model.sidebars.left;
  const right = model.sidebars.right;
  const phone = model.layout === 'phone';
  return (
    <div className={`pm-app pm-layout-${model.layout}`}>
      <Ribbon model={model} />
      {phone && (left.open || right.open) && (
        <div
          className="pm-drawer-backdrop"
          onClick={() => model.closeDrawers()}
          aria-hidden="true"
        />
      )}
      {left.open && model.panels.some((p) => p.side === 'left') && (
        <Sidebar model={model} side="left" vaultName={vaultName} />
      )}
      <main className="pm-main">
        <TabBar model={model} />
        <div className="pm-main-content">
          {model.tabs.map((leaf) => (
            <LeafHost key={leaf.id} leaf={leaf} visible={leaf === model.activeTab} />
          ))}
          {model.tabs.length === 0 && <EmptyState model={model} />}
        </div>
      </main>
      {right.open && model.panels.some((p) => p.side === 'right') && (
        <Sidebar model={model} side="right" vaultName={vaultName} />
      )}
      <StatusBar model={model} />
      <Overlays model={model} />
      <Notices model={model} />
    </div>
  );
}

function Ribbon({ model }: { model: WorkspaceModel }) {
  const leftPanels = model.panels.filter((p) => p.side === 'left');
  return (
    <nav className="pm-ribbon" aria-label="Ribbon">
      <button
        className="pm-icon-button"
        title="Toggle left sidebar"
        onClick={() => model.toggleSidebar('left')}
      >
        <Icon name="panel-left" />
      </button>
      {leftPanels.map((p) => (
        <button
          key={p.id}
          className="pm-icon-button"
          data-active={model.sidebars.left.open && model.sidebars.left.activePanel === p.id}
          aria-pressed={model.sidebars.left.open && model.sidebars.left.activePanel === p.id}
          aria-label={p.title}
          title={p.title}
          onClick={() =>
            model.sidebars.left.open && model.sidebars.left.activePanel === p.id
              ? model.toggleSidebar('left', false)
              : model.showPanel(p.id)
          }
        >
          <Icon name={p.icon ?? 'file'} />
        </button>
      ))}
      {model.ribbonActions.length > 0 && <div className="pm-ribbon-separator" role="separator" />}
      {model.ribbonActions.map((a) => (
        <button
          key={a.id}
          className="pm-icon-button pm-ribbon-action"
          aria-label={a.title}
          title={a.title}
          onClick={() => {
            if (model.layout === 'phone') model.closeDrawers();
            void Promise.resolve(a.run()).catch((e: unknown) =>
              model.notify(e instanceof Error ? e.message : String(e), { kind: 'error' }),
            );
          }}
        >
          <Icon name={a.icon} />
        </button>
      ))}
      <div className="pm-ribbon-spacer" />
      <button
        className="pm-icon-button"
        title="Settings"
        onClick={() => void model.commands().execute('settings.open')}
      >
        <Icon name="settings" />
      </button>
      {model.panels.some((p) => p.side === 'right') && (
        <button
          className="pm-icon-button"
          title="Toggle right sidebar"
          onClick={() => model.toggleSidebar('right')}
        >
          <Icon name="panel-right" />
        </button>
      )}
    </nav>
  );
}

function Sidebar({
  model,
  side,
  vaultName,
}: {
  model: WorkspaceModel;
  side: 'left' | 'right';
  vaultName: string;
}) {
  const panels = model.panels.filter((p) => p.side === side);
  const state = model.sidebars[side];
  const [width, setWidth] = useState(side === 'left' ? 260 : 280);
  const onResize = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: PointerEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      setWidth(Math.max(180, Math.min(520, startWidth + delta)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <aside
      className={`pm-sidebar pm-sidebar-${side}`}
      style={model.layout === 'phone' ? undefined : { width }}
    >
      <header className="pm-sidebar-header">
        {side === 'left' && (
          <button
            className="pm-vault-name"
            title="Switch vault"
            onClick={() =>
              void model
                .commands()
                .execute('vaults.switch')
                .catch(() => undefined)
            }
          >
            {vaultName}
          </button>
        )}
        {panels.length > 1 && (
          <div className="pm-panel-tabs">
            {panels.map((p) => (
              <button
                key={p.id}
                className="pm-icon-button"
                data-active={state.activePanel === p.id}
                aria-pressed={state.activePanel === p.id}
                aria-label={p.title}
                title={p.title}
                onClick={() => model.showPanel(p.id)}
              >
                <Icon name={p.icon ?? 'file'} />
              </button>
            ))}
          </div>
        )}
        {panels.length === 1 && side === 'right' && (
          <span className="pm-panel-title">{panels[0]!.title}</span>
        )}
      </header>
      <div className="pm-sidebar-content">
        {[...model.sidebarLeaves.values()]
          .filter((l) => l.location === side)
          .map((leaf) => (
            <LeafHost key={leaf.id} leaf={leaf} visible={leaf.panelId === state.activePanel} />
          ))}
        {panels.length === 0 && <div className="pm-empty-panel">Nothing here yet</div>}
      </div>
      <div className="pm-resize-handle" onPointerDown={onResize} />
    </aside>
  );
}

function TabBar({ model }: { model: WorkspaceModel }) {
  const [dragging, setDragging] = useState<Leaf | undefined>();
  if (model.tabs.length === 0) return <div className="pm-tabbar" />;
  return (
    <div className="pm-tabbar" role="tablist">
      <div className="pm-nav">
        <button
          className="pm-icon-button"
          title="Back"
          aria-label="Back"
          disabled={!model.canGo(-1)}
          onClick={() => void model.go(-1)}
        >
          <Icon name="arrow-left" size={15} />
        </button>
        <button
          className="pm-icon-button"
          title="Forward"
          aria-label="Forward"
          disabled={!model.canGo(1)}
          onClick={() => void model.go(1)}
        >
          <Icon name="arrow-right" size={15} />
        </button>
      </div>
      {model.tabs.map((leaf, i) => (
        <div
          key={leaf.id}
          role="tab"
          aria-selected={leaf === model.activeTab}
          className="pm-tab"
          data-active={leaf === model.activeTab}
          draggable
          onDragStart={() => setDragging(leaf)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => dragging && model.moveTab(dragging, i)}
          onDragEnd={() => setDragging(undefined)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              model.closeTab(leaf);
            } else if (e.button === 0) model.activate(leaf);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const path = leaf.path;
            model.showContextMenu(
              [
                ...(path && model.viewersFor(path).length > 1
                  ? [
                      {
                        label: 'Open with…',
                        icon: 'eye',
                        run: () => void model.openFileWith(path),
                      },
                      'separator' as const,
                    ]
                  : []),
                { label: 'Close', icon: 'x', run: () => model.closeTab(leaf) },
              ],
              { x: e.clientX, y: e.clientY },
            );
          }}
          title={leaf.path ?? leaf.title}
        >
          <span className="pm-tab-title">{leaf.title}</span>
          <button
            className="pm-tab-close"
            aria-label="Close tab"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => model.closeTab(leaf)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ model }: { model: WorkspaceModel }) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl+';
  return (
    <div className="pm-empty">
      <div className="pm-empty-title">No file is open</div>
      <ul>
        <li>
          <button onClick={() => void model.commands().execute('explorer.new-note')}>
            Create new note
          </button>
          <kbd>{mod}N</kbd>
        </li>
        <li>
          <button onClick={() => void model.commands().execute('switcher.open')}>Go to file</button>
          <kbd>{mod}O</kbd>
        </li>
        <li>
          <button onClick={() => void model.commands().execute('palette.open')}>
            Command palette
          </button>
          <kbd>{mod}P</kbd>
        </li>
      </ul>
    </div>
  );
}

function StatusBar({ model }: { model: WorkspaceModel }) {
  return (
    <footer className="pm-statusbar">
      {model.statusItems.map((item) => (
        <span key={item.id}>{item.text}</span>
      ))}
    </footer>
  );
}

function Notices({ model }: { model: WorkspaceModel }) {
  return (
    <div className="pm-notices" aria-live="polite">
      {model.notices.map((n) => (
        <div
          key={n.id}
          className="pm-notice"
          data-kind={n.kind}
          onClick={() => model.dismissNotice(n.id)}
        >
          {n.message}
        </div>
      ))}
    </div>
  );
}

function Overlays({ model }: { model: WorkspaceModel }) {
  return (
    <>
      {model.overlays.map((o, i) => {
        switch (o.kind) {
          case 'quickpick':
            return <QuickPick key={i} model={model} overlay={o} />;
          case 'prompt':
            return <Prompt key={i} model={model} overlay={o} />;
          case 'confirm':
            return <Confirm key={i} model={model} overlay={o} />;
          case 'menu':
            return <ContextMenu key={i} model={model} overlay={o} />;
        }
      })}
    </>
  );
}

function Modal({
  onClose,
  children,
  className,
}: {
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    // Capture phase: Escape closes the dialog even if something else grabbed focus.
    window.addEventListener('keydown', onKey, true);
    // Keep focus inside the dialog if a view tries to take it.
    const onFocusIn = (e: FocusEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node))
        el.querySelector<HTMLElement>('input, button')?.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [onClose]);
  return (
    <div
      className="pm-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={ref} className={`pm-modal ${className ?? ''}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const matches = new Set(fuzzyMatch(query, text)?.matches ?? []);
  if (!matches.size) return <>{text}</>;
  return (
    <>
      {[...text].map((ch, i) =>
        matches.has(i) ? (
          <mark key={i} className="pm-match">
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  );
}

function QuickPick({
  model,
  overlay,
}: {
  model: WorkspaceModel;
  overlay: Extract<Overlay, { kind: 'quickpick' }>;
}) {
  const { options } = overlay;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo(() => {
    const base =
      typeof options.items === 'function'
        ? options.items(query)
        : fuzzyFilter(query, options.items, (i) => `${i.label} ${i.detail ?? ''}`);
    const limited = base.slice(0, 200);
    if (
      query.trim() &&
      options.onEmpty &&
      !limited.some((i) => i.label.toLowerCase() === query.trim().toLowerCase())
    ) {
      const extra = options.onEmpty(query.trim());
      if (extra) return [...limited, extra];
    }
    return limited;
  }, [options, query]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = (item?: QuickPickItem) => model.closeOverlay(overlay, item);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      close(items[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <Modal onClose={() => close()} className="pm-quickpick">
      <input
        className="pm-quickpick-input"
        autoFocus
        placeholder={options.placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul className="pm-quickpick-list" ref={listRef} role="listbox">
        {items.map((item, i) => (
          <li
            key={`${item.label}-${i}`}
            role="option"
            aria-selected={i === selected}
            data-selected={i === selected}
            onMouseMove={() => setSelected(i)}
            onClick={() => close(item)}
          >
            <span className="pm-quickpick-label">
              <Highlighted text={item.label} query={query} />
            </span>
            {item.detail && <span className="pm-quickpick-detail">{item.detail}</span>}
            {item.hint && <span className="pm-quickpick-hint">{item.hint}</span>}
          </li>
        ))}
        {items.length === 0 && <li className="pm-quickpick-empty">No matches</li>}
      </ul>
    </Modal>
  );
}

function Prompt({
  model,
  overlay,
}: {
  model: WorkspaceModel;
  overlay: Extract<Overlay, { kind: 'prompt' }>;
}) {
  const { options } = overlay;
  const [value, setValue] = useState(options.value ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const [start, end] = options.selection ?? [0, input.value.length];
    input.setSelectionRange(start, end);
  }, [options]);
  return (
    <Modal onClose={() => model.closeOverlay(overlay)} className="pm-prompt">
      <div className="pm-modal-title">{options.title}</div>
      <input
        ref={ref}
        className="pm-text-input"
        value={value}
        placeholder={options.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') model.closeOverlay(overlay, value);
          if (e.key === 'Escape') model.closeOverlay(overlay);
        }}
      />
    </Modal>
  );
}

function Confirm({
  model,
  overlay,
}: {
  model: WorkspaceModel;
  overlay: Extract<Overlay, { kind: 'confirm' }>;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal onClose={() => model.closeOverlay(overlay, false)} className="pm-confirm">
      <div className="pm-confirm-message">{overlay.message}</div>
      <div className="pm-modal-buttons">
        <button className="pm-button" onClick={() => model.closeOverlay(overlay, false)}>
          Cancel
        </button>
        <button
          ref={ref}
          className="pm-button"
          data-variant={overlay.danger ? 'danger' : 'primary'}
          onClick={() => model.closeOverlay(overlay, true)}
          onKeyDown={(e) => e.key === 'Escape' && model.closeOverlay(overlay, false)}
        >
          {overlay.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function ContextMenu({
  model,
  overlay,
}: {
  model: WorkspaceModel;
  overlay: Extract<Overlay, { kind: 'menu' }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(overlay.at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(overlay.at.x, window.innerWidth - rect.width - 8),
      y: Math.min(overlay.at.y, window.innerHeight - rect.height - 8),
    });
    el.focus();
  }, [overlay]);
  const close = () => model.closeOverlay(overlay);
  return (
    <div
      className="pm-menu-backdrop"
      onMouseDown={close}
      onContextMenu={(e) => (e.preventDefault(), close())}
    >
      <div
        className="pm-menu"
        role="menu"
        tabIndex={-1}
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        {overlay.entries.map((entry: MenuEntry, i) =>
          entry === 'separator' ? (
            <div key={i} className="pm-menu-separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className="pm-menu-item"
              data-danger={entry.danger}
              disabled={entry.disabled}
              onClick={() => {
                close();
                void entry.run();
              }}
            >
              {entry.checked !== undefined && (
                <span className="pm-menu-check">
                  {entry.checked && <Icon name="check" size={14} />}
                </span>
              )}
              {entry.icon && <Icon name={entry.icon} size={15} />}
              {entry.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
