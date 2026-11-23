import {
  Emitter,
  basename,
  type Disposable,
  type FileHandlerRegistration,
  type FileViewer,
  type MenuEntry,
  type PluginContext,
  type PromptOptions,
  type QuickPickItem,
  type QuickPickOptions,
  type RibbonAction,
  type SidebarPanelRegistration,
  type ViewInstance,
  type ViewLocation,
  type ViewRegistration,
  type ViewState,
  type VaultPath,
  type WorkspaceApi,
  type WorkspaceLayout,
} from '@pumice/api';

export interface Leaf {
  id: number;
  location: ViewLocation;
  viewType: string;
  state: ViewState;
  title: string;
  path: VaultPath | undefined;
  /** Stable element the view renders into; React only re-parents it. */
  container: HTMLElement;
  instance?: ViewInstance;
  /** Sidebar panel this leaf belongs to. */
  panelId?: string;
  /** What this tab has shown, for back and forward (main tabs only). */
  history: HistoryEntry[];
  historyIndex: number;
}

export interface HistoryEntry {
  type: string;
  state: ViewState;
}

export interface SidebarState {
  open: boolean;
  activePanel: string | undefined;
}

export type Overlay =
  | {
      kind: 'quickpick';
      options: QuickPickOptions<QuickPickItem>;
      resolve: (item: QuickPickItem | undefined) => void;
    }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | undefined) => void }
  | {
      kind: 'confirm';
      message: string;
      confirmLabel: string;
      danger: boolean;
      resolve: (ok: boolean) => void;
    }
  | { kind: 'menu'; entries: MenuEntry[]; at: { x: number; y: number }; resolve: () => void };

export interface Notice {
  id: number;
  message: string;
  kind: 'info' | 'warning' | 'error';
}

export interface StatusItem {
  id: number;
  order: number;
  text: string;
}

interface SavedLayout {
  tabs: { viewType: string; state: ViewState }[];
  active: number;
  left: SidebarState;
  right: SidebarState;
}

let nextId = 1;

/** All workspace state. React components subscribe through `onDidChange`. */
export class WorkspaceModel implements WorkspaceApi {
  readonly views = new Map<string, ViewRegistration>();
  readonly fileHandlers: FileHandlerRegistration[] = [];
  readonly panels: SidebarPanelRegistration[] = [];
  readonly ribbonActions: RibbonAction[] = [];
  readonly tabs: Leaf[] = [];
  readonly sidebarLeaves = new Map<string, Leaf>();
  activeTab: Leaf | undefined;
  readonly sidebars: Record<'left' | 'right', SidebarState> = {
    left: { open: true, activePanel: undefined },
    right: { open: false, activePanel: undefined },
  };
  overlays: Overlay[] = [];
  notices: Notice[] = [];
  statusItems: StatusItem[] = [];
  private closedTabs: { viewType: string; state: ViewState }[] = [];

  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly activeFileChanged = new Emitter<VaultPath | undefined>();
  readonly onDidChangeActiveFile = this.activeFileChanged.event;
  private readonly layoutChanged = new Emitter<WorkspaceLayout>();
  readonly onDidChangeLayout = this.layoutChanged.event;
  layout: WorkspaceLayout = computeLayout();
  private readonly onResize = () => {
    const next = computeLayout();
    if (next === this.layout) return;
    this.layout = next;
    // Drawers start closed on phones.
    if (next === 'phone') {
      this.sidebars.left.open = false;
      this.sidebars.right.open = false;
    }
    this.layoutChanged.fire(next);
    this.update();
  };
  private lastActiveFile: VaultPath | undefined;
  private restored = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on each change; React's useSyncExternalStore snapshot. */
  version = 0;

  constructor(private readonly ctx: PluginContext) {
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize);
      ctx.register(() => window.removeEventListener('resize', this.onResize));
      if (this.layout === 'phone') {
        this.sidebars.left.open = false;
        this.sidebars.right.open = false;
      }
    }
  }

  // ---- registration ------------------------------------------------------------------------

  registerView(view: ViewRegistration): Disposable {
    if (this.views.has(view.type)) throw new Error(`View type '${view.type}' already registered`);
    this.views.set(view.type, view);
    this.update();
    return {
      dispose: () => {
        for (const leaf of [...this.tabs, ...this.sidebarLeaves.values()]) {
          if (leaf.viewType === view.type) this.destroyLeaf(leaf);
        }
        this.views.delete(view.type);
        this.update();
      },
    };
  }

  registerFileHandler(handler: FileHandlerRegistration): Disposable {
    this.fileHandlers.push(handler);
    return { dispose: () => remove(this.fileHandlers, handler) };
  }

  registerSidebarPanel(panel: SidebarPanelRegistration): Disposable {
    this.panels.push(panel);
    this.panels.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    const side = this.sidebars[panel.side];
    side.activePanel ??= panel.id;
    this.update();
    return {
      dispose: () => {
        remove(this.panels, panel);
        const leaf = this.sidebarLeaves.get(panel.id);
        if (leaf) this.destroyLeaf(leaf);
        if (side.activePanel === panel.id)
          side.activePanel = this.panels.find((p) => p.side === panel.side)?.id;
        this.update();
      },
    };
  }

  registerRibbonAction(action: RibbonAction): Disposable {
    this.ribbonActions.push(action);
    this.ribbonActions.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    this.update();
    return {
      dispose: () => {
        remove(this.ribbonActions, action);
        this.update();
      },
    };
  }

  addStatusBarItem(order = 100) {
    const item: StatusItem = { id: nextId++, order, text: '' };
    this.statusItems = [...this.statusItems, item].sort((a, b) => a.order - b.order);
    this.update();
    return {
      setText: (text: string) => {
        item.text = text;
        this.statusItems = [...this.statusItems];
        this.update();
      },
      dispose: () => {
        this.statusItems = this.statusItems.filter((i) => i !== item);
        this.update();
      },
    };
  }

  commands() {
    return this.ctx.commands;
  }

  // ---- tabs and views ----------------------------------------------------------------------

  get activeFile(): VaultPath | undefined {
    return this.activeTab?.path;
  }

  /** Every registered way to open the file: regular views first, longer endings first. */
  private candidates(path: VaultPath): Array<{ handler: FileHandlerRegistration; ext: string }> {
    const name = basename(path).toLowerCase();
    const found = new Map<string, { handler: FileHandlerRegistration; ext: string }>();
    for (const handler of this.fileHandlers) {
      for (const listed of handler.extensions) {
        // `*`: any file (a plain text view); it never takes a file from a viewer for its type.
        const ext = listed === '*' ? '' : listed;
        if (ext && !name.endsWith(`.${ext.toLowerCase()}`)) continue;
        const id = handler.id ?? handler.viewType;
        const known = found.get(id);
        if (!known || ext.length > known.ext.length) found.set(id, { handler, ext });
      }
    }
    return [...found.values()].sort(
      (a, b) =>
        Number(!!a.handler.optional) - Number(!!b.handler.optional) || b.ext.length - a.ext.length,
    );
  }

  /** The ending the user's choice of viewer is remembered under. */
  private typeOf(path: VaultPath): string {
    const name = basename(path).toLowerCase();
    return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  }

  /**
   * The view for a file: the one the user chose for the type, else its regular view, else the
   * only additional viewer. Undefined when there is none, or several to choose from.
   */
  handlerFor(path: VaultPath, viewer?: string): FileHandlerRegistration | undefined {
    const all = this.candidates(path);
    const byId = (id: string | undefined) =>
      id ? all.find((c) => (c.handler.id ?? c.handler.viewType) === id)?.handler : undefined;
    const chosen =
      byId(viewer) ??
      byId(this.ctx.settings.get<Record<string, string>>('openWith', {})[this.typeOf(path)]);
    if (chosen) return chosen;
    const regular = all.find((c) => !c.handler.optional);
    if (regular) return regular.handler;
    // One viewer made for this type opens it; a viewer for any file only when there is none.
    const made = all.filter((c) => c.ext !== '');
    if (made.length === 1) return made[0]!.handler;
    return made.length === 0 && all.length === 1 ? all[0]!.handler : undefined;
  }

  private titleOf(handler: FileHandlerRegistration): string {
    return handler.title ?? this.views.get(handler.viewType)?.title ?? handler.viewType;
  }

  /** Whether a tab shows its file through this handler. */
  private shows(leaf: Leaf, handler: FileHandlerRegistration): boolean {
    if (leaf.viewType !== handler.viewType) return false;
    const state = leaf.instance?.getState?.() ?? leaf.state;
    return Object.entries(handler.state ?? {}).every(([key, value]) => state[key] === value);
  }

  viewersFor(path: VaultPath): FileViewer[] {
    const tab = this.tabs.find((t) => t.path === path);
    const fallback = this.handlerFor(path);
    return this.candidates(path).map(({ handler }) => ({
      id: handler.id ?? handler.viewType,
      title: this.titleOf(handler),
      current: tab ? this.shows(tab, handler) : handler === fallback,
    }));
  }

  private async activateFileType(path: VaultPath): Promise<void> {
    // Let lazy plugins that handle this file type register their handler first.
    const parts = basename(path).toLowerCase().split('.').slice(1);
    for (let i = 0; i < parts.length; i++)
      await this.ctx.activate(`onFileType:${parts.slice(i).join('.')}`);
  }

  /** Asks which viewer to use for a file. */
  private async pickViewer(path: VaultPath): Promise<string | undefined> {
    const viewers = this.viewersFor(path);
    const picked = await this.showQuickPick({
      placeholder: `Open ${basename(path)} with…`,
      items: viewers.map((v) => ({
        label: v.title,
        ...(v.current ? { hint: 'current' } : {}),
        id: v.id,
      })),
    });
    return picked?.id;
  }

  async openFileWith(path: VaultPath): Promise<void> {
    await this.activateFileType(path);
    if (!this.candidates(path).length) {
      this.notify(`No view can open '${basename(path)}'`, { kind: 'warning' });
      return;
    }
    const viewer = await this.pickViewer(path);
    if (!viewer) return;
    // The choice holds for this type of file from now on.
    const type = this.typeOf(path);
    if (type) {
      const openWith = { ...this.ctx.settings.get<Record<string, string>>('openWith', {}) };
      openWith[type] = viewer;
      await this.ctx.settings.set('openWith', openWith);
    }
    await this.openFile(path, { viewer });
  }

  async openFile(
    path: VaultPath,
    opts: { newTab?: boolean; state?: ViewState; viewer?: string } = {},
  ): Promise<void> {
    await this.activateFileType(path);
    const handler = this.handlerFor(path, opts.viewer);
    if (!handler) {
      const all = this.candidates(path);
      if (!all.length) {
        this.notify(`No view can open '${basename(path)}'`, { kind: 'warning' });
        return;
      }
      // Several additional viewers and no regular one: the user chooses (once per type).
      return this.openFileWith(path);
    }
    const state = { ...handler.state, ...opts.state, path };
    const existing = this.tabs.find((t) => t.path === path);
    if (existing && !opts.newTab) {
      this.activate(existing);
      // Another viewer was asked for: the tab changes to it.
      if (!this.shows(existing, handler)) {
        await this.navigate(existing, { type: handler.viewType, state }, true);
        return;
      }
      if (opts.state) await existing.instance?.setState?.({ ...opts.state, path });
      return;
    }
    await this.openView(handler.viewType, { state, newTab: opts.newTab });
  }

  async openView(
    type: string,
    opts: { location?: ViewLocation; state?: ViewState; newTab?: boolean } = {},
  ): Promise<void> {
    await this.ctx.activate(`onView:${type}`);
    const location = opts.location ?? 'main';
    const state = opts.state ?? {};
    // On phones, opening something in the main pane closes the drawers.
    if (location === 'main' && this.layout === 'phone') this.closeDrawers();
    if (location !== 'main') {
      const panel =
        this.panels.find((p) => p.viewType === type && p.side === location) ??
        this.panels.find((p) => p.viewType === type);
      if (!panel) return;
      this.showPanel(panel.id);
      const leaf = await this.ensurePanelLeaf(panel.side);
      if (leaf && Object.keys(state).length) await leaf.instance?.setState?.(state);
      leaf?.instance?.focus?.();
      return;
    }
    const current = this.activeTab;
    // Like Obsidian: navigating replaces the current tab unless asked for a new one.
    if (current && !opts.newTab) {
      await this.navigate(current, { type, state }, true);
      return;
    }
    const leaf = await this.createLeaf('main', type, state);
    const index = current ? this.tabs.indexOf(current) + 1 : this.tabs.length;
    this.tabs.splice(index, 0, leaf);
    this.activate(leaf);
  }

  /**
   * Shows something else in a tab. `record` adds it to the tab's history (false when moving
   * through the history itself).
   */
  private async navigate(
    current: Leaf,
    to: HistoryEntry,
    record: boolean,
    targetIndex?: number,
  ): Promise<void> {
    const { history } = current;
    // Remember where the tab was (cursor, mode, …) so coming back restores it.
    const leaving = history[current.historyIndex];
    if (leaving) leaving.state = current.instance?.getState?.() ?? current.state;
    let index = targetIndex ?? current.historyIndex;
    if (record) {
      const same = leaving && leaving.type === to.type && leaving.state.path === to.state.path;
      if (same) history[index] = to;
      else {
        history.splice(index + 1, history.length, to);
        if (history.length > 50) history.shift();
        index = history.length - 1;
      }
    }
    if (current.viewType === to.type && current.instance?.setState) {
      current.state = to.state;
      current.path = to.state.path;
      current.historyIndex = index;
      await current.instance.setState(to.state);
      this.activate(current);
      return;
    }
    const at = this.tabs.indexOf(current);
    this.destroyLeaf(current);
    const leaf = await this.createLeaf('main', to.type, to.state);
    leaf.history = history;
    leaf.historyIndex = index;
    this.tabs.splice(at, 0, leaf);
    this.activate(leaf);
  }

  canGo(delta: -1 | 1): boolean {
    const tab = this.activeTab;
    return !!tab && tab.historyIndex + delta >= 0 && tab.historyIndex + delta < tab.history.length;
  }

  /** Back (-1) or forward (1) in the active tab's history. */
  async go(delta: -1 | 1): Promise<void> {
    const tab = this.activeTab;
    if (!tab || !this.canGo(delta)) return;
    // Skip entries whose file is gone.
    let index = tab.historyIndex + delta;
    while (
      index >= 0 &&
      index < tab.history.length &&
      tab.history[index]!.state.path !== undefined &&
      !this.handlerFor(tab.history[index]!.state.path as VaultPath)
    )
      index += delta;
    const entry = tab.history[index];
    if (!entry) return;
    await this.navigate(tab, entry, false, index);
    this.update();
  }

  closeFile(path: VaultPath): void {
    for (const leaf of this.tabs.filter((t) => t.path === path)) this.closeTab(leaf);
  }

  closeTab(leaf: Leaf): void {
    const index = this.tabs.indexOf(leaf);
    if (index === -1) return;
    this.closedTabs.push({
      viewType: leaf.viewType,
      state: leaf.instance?.getState?.() ?? leaf.state,
    });
    this.closedTabs = this.closedTabs.slice(-20);
    this.destroyLeaf(leaf);
    this.recentTabs = this.recentTabs.filter((t) => t !== leaf && this.tabs.includes(t));
    // Back to the tab that was looked at before this one (its neighbour if there was none).
    if (this.activeTab === leaf || !this.activeTab)
      this.activate(
        this.recentTabs[this.recentTabs.length - 1] ??
          this.tabs[Math.min(index, this.tabs.length - 1)],
      );
    else this.update();
  }

  async reopenClosedTab(): Promise<void> {
    const last = this.closedTabs.pop();
    if (last) await this.openView(last.viewType, { state: last.state, newTab: true });
  }

  /** The tabs in the order they were last looked at, the current one last. */
  private recentTabs: Leaf[] = [];

  activate(leaf: Leaf | undefined): void {
    this.activeTab = leaf;
    if (leaf) this.recentTabs = [...this.recentTabs.filter((t) => t !== leaf), leaf];
    this.update();
    if (leaf) requestAnimationFrame(() => this.focusActive());
  }

  cycleTab(delta: number): void {
    if (this.tabs.length < 2 || !this.activeTab) return;
    const i = this.tabs.indexOf(this.activeTab);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  }

  moveTab(leaf: Leaf, toIndex: number): void {
    const from = this.tabs.indexOf(leaf);
    if (from === -1) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.min(toIndex, this.tabs.length), 0, leaf);
    this.update();
  }

  // ---- sidebars ----------------------------------------------------------------------------

  toggleSidebar(side: 'left' | 'right', open?: boolean): void {
    this.sidebars[side].open = open ?? !this.sidebars[side].open;
    if (this.sidebars[side].open) void this.ensurePanelLeaf(side);
    this.update();
  }

  closeDrawers(): void {
    if (!this.sidebars.left.open && !this.sidebars.right.open) return;
    this.sidebars.left.open = false;
    this.sidebars.right.open = false;
    this.update();
  }

  showPanel(panelId: string): void {
    const panel = this.panels.find((p) => p.id === panelId);
    if (!panel) return;
    const side = this.sidebars[panel.side];
    side.activePanel = panelId;
    side.open = true;
    void this.ensurePanelLeaf(panel.side);
    this.update();
  }

  /** Creates the leaf for the active panel of a sidebar on first display. */
  async ensurePanelLeaf(side: 'left' | 'right'): Promise<Leaf | undefined> {
    const panelId = this.sidebars[side].activePanel;
    const panel = this.panels.find((p) => p.id === panelId);
    if (!panel) return undefined;
    let leaf = this.sidebarLeaves.get(panel.id);
    if (!leaf) {
      leaf = await this.createLeaf(side, panel.viewType, {});
      leaf.panelId = panel.id;
      this.sidebarLeaves.set(panel.id, leaf);
      this.update();
    }
    return leaf;
  }

  // ---- dialogs -----------------------------------------------------------------------------

  showQuickPick<T extends QuickPickItem>(options: QuickPickOptions<T>): Promise<T | undefined> {
    return new Promise((resolve) => {
      this.pushOverlay({
        kind: 'quickpick',
        options: options as unknown as QuickPickOptions<QuickPickItem>,
        resolve: resolve as (item: QuickPickItem | undefined) => void,
      });
    });
  }

  showPrompt(options: PromptOptions): Promise<string | undefined> {
    return new Promise((resolve) => this.pushOverlay({ kind: 'prompt', options, resolve }));
  }

  confirm(
    message: string,
    opts: { confirmLabel?: string; danger?: boolean } = {},
  ): Promise<boolean> {
    return new Promise((resolve) =>
      this.pushOverlay({
        kind: 'confirm',
        message,
        confirmLabel: opts.confirmLabel ?? 'OK',
        danger: opts.danger ?? false,
        resolve,
      }),
    );
  }

  showContextMenu(entries: MenuEntry[], at: { x: number; y: number }): void {
    this.pushOverlay({ kind: 'menu', entries, at, resolve: () => undefined });
  }

  closeOverlay(overlay: Overlay, result?: unknown): void {
    this.overlays = this.overlays.filter((o) => o !== overlay);
    (overlay.resolve as (value: unknown) => void)(result);
    this.update();
    requestAnimationFrame(() => this.focusActive());
  }

  /** Focuses the active tab's view, unless a dialog has focus. */
  focusActive(): void {
    if (this.overlays.length) return;
    this.activeTab?.instance?.focus?.();
  }

  notify(message: string, opts: { kind?: Notice['kind']; timeout?: number } = {}): void {
    const notice: Notice = { id: nextId++, message, kind: opts.kind ?? 'info' };
    this.notices = [...this.notices, notice];
    this.update();
    setTimeout(
      () => this.dismissNotice(notice.id),
      opts.timeout ?? (notice.kind === 'error' ? 8000 : 4000),
    );
  }

  dismissNotice(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.update();
  }

  // ---- persistence -------------------------------------------------------------------------

  async restoreLayout(): Promise<void> {
    const saved = this.ctx.settings.get<SavedLayout | undefined>('layout', undefined);
    if (saved) {
      Object.assign(this.sidebars.left, saved.left);
      Object.assign(this.sidebars.right, saved.right);
      for (const tab of saved.tabs) {
        await this.ctx.activate(`onView:${tab.viewType}`);
        if (!this.views.has(tab.viewType)) continue;
        try {
          this.tabs.push(await this.createLeaf('main', tab.viewType, tab.state));
        } catch (e) {
          this.ctx.log.warn('could not restore tab', tab, e);
        }
      }
      this.activate(this.tabs[Math.min(saved.active, this.tabs.length - 1)]);
    }
    if (this.layout === 'phone') {
      this.sidebars.left.open = false;
      this.sidebars.right.open = false;
    }
    for (const side of ['left', 'right'] as const) {
      if (!this.panels.some((p) => p.id === this.sidebars[side].activePanel)) {
        this.sidebars[side].activePanel = this.panels.find((p) => p.side === side)?.id;
      }
      if (this.sidebars[side].open) await this.ensurePanelLeaf(side);
    }
    this.restored = true;
    this.update();
  }

  private scheduleSave(): void {
    if (!this.restored) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const layout: SavedLayout = {
        tabs: this.tabs.map((t) => ({
          viewType: t.viewType,
          state: t.instance?.getState?.() ?? t.state,
        })),
        active: this.activeTab ? this.tabs.indexOf(this.activeTab) : 0,
        left: { ...this.sidebars.left },
        right: { ...this.sidebars.right },
      };
      void this.ctx.settings.set('layout', layout);
    }, 500);
  }

  // ---- internals ---------------------------------------------------------------------------

  private async createLeaf(
    location: ViewLocation,
    viewType: string,
    state: ViewState,
  ): Promise<Leaf> {
    const view = this.views.get(viewType);
    if (!view) throw new Error(`Unknown view type '${viewType}'`);
    const container = document.createElement('div');
    container.className = 'pm-view';
    container.dataset.type = viewType;
    const leaf: Leaf = {
      id: nextId++,
      location,
      viewType,
      state,
      title: view.title,
      path: state.path,
      container,
      history: [{ type: viewType, state }],
      historyIndex: 0,
    };
    leaf.instance = await view.create(
      {
        container,
        location,
        setTitle: (title) => {
          leaf.title = title;
          this.update();
        },
        setFile: (path) => {
          leaf.path = path;
          this.update();
        },
      },
      state,
    );
    return leaf;
  }

  private destroyLeaf(leaf: Leaf): void {
    remove(this.tabs, leaf);
    if (leaf.panelId) this.sidebarLeaves.delete(leaf.panelId);
    if (this.activeTab === leaf) this.activeTab = undefined;
    try {
      leaf.instance?.dispose?.();
    } catch (e) {
      this.ctx.log.error('view dispose failed', e);
    }
    leaf.container.remove();
  }

  private pushOverlay(overlay: Overlay): void {
    // Only one modal at a time; a new one cancels the previous.
    for (const o of this.overlays) (o.resolve as (v: unknown) => void)(undefined);
    this.overlays = [overlay];
    this.update();
  }

  update(): void {
    this.version++;
    this.changed.fire();
    if (this.activeFile !== this.lastActiveFile) {
      this.lastActiveFile = this.activeFile;
      this.activeFileChanged.fire(this.activeFile);
    }
    this.scheduleSave();
  }
}

function remove<T>(array: T[], item: T): void {
  const i = array.indexOf(item);
  if (i !== -1) array.splice(i, 1);
}

/** Phone below 640 px, tablet below 1024 px or with a coarse pointer, desktop otherwise. */
export function computeLayout(): WorkspaceLayout {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  if (w < 640) return 'phone';
  if (w < 1024 && window.matchMedia?.('(pointer: coarse)').matches) return 'tablet';
  return 'desktop';
}
