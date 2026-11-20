import type { DisposableLike, Disposable, Event } from '../lifecycle';
import type { PluginManifest } from '../manifest';
import { defineService } from '../service';

export interface SettingsTab {
  id: string;
  title: string;
  /** Tabs are grouped: app options first, then one tab per plugin with settings. */
  group?: 'app' | 'plugins';
  order?: number;
  /** Fills `container`; the return value is disposed when the tab closes. */
  render(container: HTMLElement): void | DisposableLike;
}

export interface SettingsUiApi {
  registerTab(tab: SettingsTab): Disposable;
  /** Opens the settings view, optionally on a tab. */
  open(tabId?: string): Promise<void>;
}

/** The settings window (provided by core.settings). */
export const SettingsUi = defineService<SettingsUiApi>('core.settings');

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** Vault folder holding `manifest.json`, `main.js` and optional `styles.css`. */
  folder: string;
}

export interface PluginFiles {
  manifest: string;
  main: string;
  styles?: string;
}

/**
 * Community plugins installed in the vault (`.pumice/extensions/<id>/`). Provided by the app
 * shell, not a plugin: it loads code into the kernel.
 */
export interface PluginManagerApi {
  installed(): InstalledPlugin[];
  install(files: PluginFiles): Promise<PluginManifest>;
  /** Fetches `manifest.json`, `main.js` and `styles.css` from a base URL (e.g. a release). */
  installFromUrl(baseUrl: string): Promise<PluginManifest>;
  uninstall(id: string): Promise<void>;
  /** Re-reads the plugin's files and reloads it (also happens automatically on change). */
  reload(id: string): Promise<void>;
  readonly onDidChange: Event<void>;
}

export const PluginManager = defineService<PluginManagerApi>('app.plugin-manager');
