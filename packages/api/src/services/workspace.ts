import type { VaultPath } from '@pumice/platform';
import type { Disposable, Event } from '../lifecycle';
import { defineService } from '../service';

export type ViewState = Record<string, unknown> & { path?: VaultPath };

export interface ViewContext {
  /** Element the view renders into. Owned by the workspace. */
  readonly container: HTMLElement;
  readonly location: ViewLocation;
  setTitle(title: string): void;
  /** Marks the leaf as showing this file (for the active-file indicator). */
  setFile(path: VaultPath | undefined): void;
}

export interface ViewInstance {
  setState?(state: ViewState): void | Promise<void>;
  getState?(): ViewState;
  focus?(): void;
  /** Called when the view is closed. */
  dispose?(): void;
}

export interface ViewRegistration {
  type: string;
  title: string;
  /** Icon name (see `@pumice/ui` icon set) or an emoji. */
  icon?: string;
  create(ctx: ViewContext, state: ViewState): ViewInstance | Promise<ViewInstance>;
}

export type ViewLocation = 'main' | 'left' | 'right';

export interface FileHandlerRegistration {
  viewType: string;
  /** Matched against the end of the file name, longest match wins. */
  extensions: string[];
}

export interface QuickPickItem {
  label: string;
  detail?: string;
  /** Right-aligned hint, e.g. a hotkey. */
  hint?: string;
}

export interface QuickPickOptions<T extends QuickPickItem> {
  placeholder?: string;
  /** Static items (fuzzy-filtered by label/detail) or a provider called on each query. */
  items: T[] | ((query: string) => T[]);
  /** Offered as the last entry when nothing matches, e.g. "Create note". */
  onEmpty?: (query: string) => T | undefined;
}

export interface PromptOptions {
  title: string;
  value?: string;
  placeholder?: string;
  /** Selects only part of `value` (e.g. without the extension). */
  selection?: [number, number];
}

export interface SidebarPanelRegistration {
  id: string;
  side: 'left' | 'right';
  viewType: string;
  title: string;
  icon?: string;
  order?: number;
}

/** A button in the ribbon (the icon strip at the window's edge; the drawer on phones). */
export interface RibbonAction {
  id: string;
  /** Icon name (see `@pumice/ui`). */
  icon: string;
  title: string;
  order?: number;
  run(): unknown;
}

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** For a list of choices: shows a check mark column, ticked on the current one. */
  checked?: boolean;
  run: () => unknown;
}

export type MenuEntry = MenuItem | 'separator';

export interface StatusBarItem extends Disposable {
  setText(text: string): void;
}

/** Screen class: `phone` uses one pane with drawers and a bottom bar. */
export type WorkspaceLayout = 'desktop' | 'tablet' | 'phone';

export interface WorkspaceApi {
  readonly layout: WorkspaceLayout;
  readonly onDidChangeLayout: Event<WorkspaceLayout>;
  registerView(view: ViewRegistration): Disposable;
  registerFileHandler(handler: FileHandlerRegistration): Disposable;
  registerSidebarPanel(panel: SidebarPanelRegistration): Disposable;
  registerRibbonAction(action: RibbonAction): Disposable;
  addStatusBarItem(order?: number): StatusBarItem;

  /** Opens a file with its registered handler. */
  openFile(path: VaultPath, opts?: { newTab?: boolean; state?: ViewState }): Promise<void>;
  openView(
    type: string,
    opts?: { location?: ViewLocation; state?: ViewState; newTab?: boolean },
  ): Promise<void>;
  closeFile(path: VaultPath): void;

  readonly activeFile: VaultPath | undefined;
  readonly onDidChangeActiveFile: Event<VaultPath | undefined>;

  showQuickPick<T extends QuickPickItem>(opts: QuickPickOptions<T>): Promise<T | undefined>;
  showPrompt(opts: PromptOptions): Promise<string | undefined>;
  confirm(message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  notify(message: string, opts?: { kind?: 'info' | 'warning' | 'error'; timeout?: number }): void;
  showContextMenu(entries: MenuEntry[], at: { x: number; y: number }): void;
}

export const Workspace = defineService<WorkspaceApi>('core.workspace');

/** Used by app shells (not plugins) to mount the UI into the page. */
export interface WorkspaceShellApi {
  mount(root: HTMLElement, opts: { vaultName: string }): void;
  unmount(): void;
}

export const WorkspaceShell = defineService<WorkspaceShellApi>('core.workspace.shell');
