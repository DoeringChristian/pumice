import type { PlatformKind, PlatformOs } from '@pumice/platform';
import type { CommandsApi } from './commands';
import type { Disposable, DisposableLike, Event } from './lifecycle';
import type { PluginManifest } from './manifest';
import type { ServiceToken } from './service';

export interface PluginSettings {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): Promise<void>;
  readonly onDidChange: Event<string>;
}

export interface PluginStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly platform: { readonly kind: PlatformKind; readonly os: PlatformOs };
  /** Returns an active service or throws. Declare its plugin in `dependencies`. */
  use<T>(token: ServiceToken<T>): T;
  /** Returns the service if its provider is active (for optional dependencies). */
  tryUse<T>(token: ServiceToken<T>): T | undefined;
  provide<T>(token: ServiceToken<T>, implementation: T): Disposable;
  /** Disposed automatically when the plugin is deactivated. */
  register<T extends DisposableLike>(disposable: T): T;
  readonly commands: CommandsApi;
  readonly settings: PluginSettings;
  /**
   * Plugin-private storage on this device, outside the vault (caches, indexes). Values are
   * strings; may be slow, so batch writes.
   */
  readonly storage: PluginStorage;
  readonly log: Logger;
  /** Activates plugins waiting for this event (e.g. `onFileType:excalidraw`). */
  activate(event: string): Promise<void>;
}

export interface PluginDefinition {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

/** What a plugin package exports: its manifest plus the definition. */
export interface PluginModule {
  manifest: PluginManifest;
  plugin: PluginDefinition;
}
