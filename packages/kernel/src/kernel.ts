import {
  type PluginInfo,
  DisposableStore,
  PlatformService,
  Plugins,
  ShellService,
  type Logger,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
  type ServiceToken,
} from '@pumice/api';
import type { Platform } from '@pumice/platform';
import semver from 'semver';
import { CommandRegistry } from './commands';
import { ServiceRegistry } from './services';
import { PluginSettingsStore, type SettingsBackend } from './settings';

/** Version of @pumice/api this kernel implements. */
export const API_VERSION = '0.1.0';

export type PluginState = PluginInfo['state'];

export interface PluginEntry {
  readonly manifest: PluginManifest;
  state: PluginState;
  error?: Error;
  /** Activation time in ms (for the startup profiler). */
  activationMs?: number;
  /** Id of the plugin that replaces this one. */
  replacedBy?: string;
}

export interface PluginSource {
  manifest: PluginManifest;
  load: () => PluginDefinition | Promise<PluginDefinition>;
}

interface InternalEntry extends PluginEntry {
  source: PluginSource;
  definition?: PluginDefinition;
  store?: DisposableStore;
  settings?: PluginSettingsStore;
  activation?: Promise<void>;
}

/** Services whose use requires a manifest permission. */
const RESTRICTED: Record<string, string> = {
  [PlatformService.id]: 'platform',
  [ShellService.id]: 'shell',
};

export interface KernelOptions {
  platform: Platform;
  settings: SettingsBackend;
  /** Plugins the user turned off (not activated, also not by events). */
  disabled?: string[];
  /** Persists the disabled set when it changes. */
  onDisabledChange?: (disabled: string[]) => void | Promise<void>;
  /** Plugins that can't be turned off (the app needs them to function). */
  required?: string[];
  log?: (pluginId: string, level: keyof Logger, args: unknown[]) => void;
}

export class Kernel {
  readonly services = new ServiceRegistry();
  readonly commands: CommandRegistry;
  private readonly plugins = new Map<string, InternalEntry>();
  /** Replaced plugin id → id of the plugin standing in for it. */
  private readonly aliases = new Map<string, string>();
  private started = false;

  constructor(private readonly options: KernelOptions) {
    this.commands = new CommandRegistry(
      options.platform.os === 'macos' || options.platform.os === 'ios',
      (id) => this.activate(id),
    );
    this.services.provide(PlatformService, options.platform, 'kernel');
    this.services.provide(ShellService, options.platform.shell, 'kernel');
    this.services.provide(
      Plugins,
      {
        list: () => this.list().map((p) => ({ ...p, error: p.error?.message })),
        setEnabled: (id, enabled) => (enabled ? this.enable(id) : this.disable(id)),
        isRequired: (id) => (options.required ?? []).includes(id),
      },
      'kernel',
    );
  }

  addPlugin(source: PluginSource): void {
    if (this.started) throw new Error('Use install() to add plugins after start()');
    const id = source.manifest.id;
    if (this.plugins.has(id)) throw new Error(`Plugin '${id}' added twice`);
    const disabled =
      (this.options.disabled ?? []).includes(id) && !(this.options.required ?? []).includes(id);
    this.plugins.set(id, {
      manifest: source.manifest,
      source,
      state: disabled ? 'disabled' : 'registered',
    });
  }

  /** Adds (or replaces) a plugin while running, e.g. a newly installed or rebuilt one. */
  async install(source: PluginSource): Promise<void> {
    if (!this.started) return this.addPlugin(source);
    const id = source.manifest.id;
    const existing = this.plugins.get(id);
    const reactivate = existing ? this.activeDependents(id) : [];
    const wasActive = existing?.state === 'active';
    if (existing) await this.deactivate(id);
    const disabled = existing?.state === 'disabled';
    const entry: InternalEntry = {
      manifest: source.manifest,
      source,
      state: disabled ? 'disabled' : 'registered',
    };
    this.plugins.set(id, entry);
    if (disabled) return;
    const error = this.validate(entry);
    if (error) {
      this.fail(entry, error);
      return;
    }
    for (const c of entry.manifest.contributes?.commands ?? [])
      this.commands.addContribution(id, c);
    if (wasActive || isStartup(entry.manifest)) await this.activate(id).catch(() => undefined);
    for (const dep of reactivate) await this.activate(dep).catch(() => undefined);
  }

  /** Deactivates and forgets a plugin (uninstall). */
  async uninstall(id: string): Promise<void> {
    await this.deactivate(id);
    this.plugins.delete(id);
  }

  async disable(id: string): Promise<void> {
    if ((this.options.required ?? []).includes(id))
      throw new Error(`'${id}' is required and can't be turned off`);
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Unknown plugin '${id}'`);
    await this.deactivate(id);
    entry.state = 'disabled';
    await this.options.onDisabledChange?.(this.disabledIds());
  }

  async enable(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Unknown plugin '${id}'`);
    if (entry.state !== 'disabled' && entry.state !== 'failed') return;
    entry.state = 'registered';
    entry.error = undefined;
    await this.options.onDisabledChange?.(this.disabledIds());
    const error = this.validate(entry);
    if (error) {
      this.fail(entry, error);
      return;
    }
    if (isStartup(entry.manifest)) await this.activate(id).catch(() => undefined);
  }

  private disabledIds(): string[] {
    return [...this.plugins.values()]
      .filter((e) => e.state === 'disabled')
      .map((e) => e.manifest.id);
  }

  /** Active plugins that depend (transitively) on `id`. */
  private activeDependents(id: string): string[] {
    const out: string[] = [];
    const visit = (target: string) => {
      for (const d of this.dependentsOf(target)) {
        if (!out.includes(d.manifest.id)) {
          out.push(d.manifest.id);
          visit(d.manifest.id);
        }
      }
    };
    visit(id);
    return out;
  }

  list(): PluginEntry[] {
    return [...this.plugins.values()].map(
      ({ manifest, state, error, activationMs, replacedBy }) => ({
        manifest,
        state,
        error,
        activationMs,
        replacedBy,
      }),
    );
  }

  get(id: string): PluginEntry | undefined {
    return this.plugins.get(this.resolveId(id));
  }

  /** Validates all plugins, then activates the startup set (and their dependencies). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.resolveReplacements();
    for (const entry of this.plugins.values()) {
      if (entry.state !== 'registered') continue;
      const error = this.validate(entry);
      if (error) this.fail(entry, error);
    }
    this.detectCycles();
    for (const entry of this.plugins.values()) {
      if (entry.state !== 'registered') continue;
      for (const c of entry.manifest.contributes?.commands ?? []) {
        this.commands.addContribution(entry.manifest.id, c);
      }
    }
    for (const entry of this.plugins.values()) {
      if (entry.state === 'registered' && isStartup(entry.manifest)) {
        // Failures are recorded on the entry; one broken plugin must not stop the app.
        await this.activate(entry.manifest.id).catch(() => undefined);
      }
    }
  }

  /** Activates all plugins listening for an activation event. */
  async activateByEvent(event: string): Promise<void> {
    const targets = [...this.plugins.values()].filter(
      (e) =>
        (e.state === 'registered' || e.state === 'inactive') &&
        e.manifest.activation?.includes(event),
    );
    for (const entry of targets) await this.activate(entry.manifest.id);
  }

  async activate(id: string): Promise<void> {
    const entry = this.plugins.get(this.resolveId(id));
    if (!entry) throw new Error(`Unknown plugin '${id}'`);
    if (entry.state === 'active') return;
    if (entry.state === 'failed') throw entry.error ?? new Error(`Plugin '${id}' failed`);
    if (entry.state === 'disabled') throw new Error(`Plugin '${id}' is turned off`);
    if (entry.activation) return entry.activation;
    entry.activation = this.doActivate(entry).finally(() => {
      entry.activation = undefined;
    });
    return entry.activation;
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.plugins.get(this.resolveId(id));
    if (!entry || entry.state !== 'active') return;
    for (const dependent of this.dependentsOf(entry.manifest.id)) {
      await this.deactivate(dependent.manifest.id);
    }
    entry.state = 'deactivating';
    try {
      await entry.definition?.deactivate?.();
    } catch (e) {
      this.log(entry.manifest.id, 'error', ['deactivate failed', e]);
    }
    try {
      entry.store?.dispose();
    } catch (e) {
      this.log(entry.manifest.id, 'error', ['dispose failed', e]);
    }
    entry.store = undefined;
    entry.state = 'inactive';
  }

  async stop(): Promise<void> {
    const active = [...this.plugins.values()].filter((e) => e.state === 'active');
    for (const entry of active.reverse()) await this.deactivate(entry.manifest.id);
  }

  private async doActivate(entry: InternalEntry): Promise<void> {
    const id = entry.manifest.id;
    entry.state = 'activating';
    try {
      for (const [dep] of Object.entries(entry.manifest.dependencies ?? {})) {
        await this.activate(dep).catch((e: Error) => {
          throw new Error(`Dependency '${dep}' failed: ${e.message}`);
        });
      }
      for (const [dep] of Object.entries(entry.manifest.optionalDependencies ?? {})) {
        const depEntry = this.plugins.get(this.resolveId(dep));
        if (depEntry && depEntry.state !== 'failed')
          await this.activate(dep).catch(() => undefined);
      }
      const started = performance.now();
      entry.definition ??= await entry.source.load();
      entry.settings ??= new PluginSettingsStore(id, this.options.settings);
      await entry.settings.load();
      entry.store = new DisposableStore();
      await entry.definition.activate(this.createContext(entry, entry.store, entry.settings));
      entry.activationMs = performance.now() - started;
      entry.state = 'active';
    } catch (e) {
      entry.store?.dispose();
      entry.store = undefined;
      this.fail(entry, e instanceof Error ? e : new Error(String(e)));
      throw entry.error;
    }
  }

  private createContext(
    entry: InternalEntry,
    store: DisposableStore,
    settings: PluginSettingsStore,
  ): PluginContext {
    const manifest = entry.manifest;
    const log = this.logger(manifest.id);
    const checkAccess = (token: ServiceToken<unknown>) => {
      const permission = RESTRICTED[token.id];
      if (permission && !manifest.permissions?.includes(permission)) {
        throw new Error(
          `Plugin '${manifest.id}' needs the '${permission}' permission to use '${token.id}'`,
        );
      }
    };
    return {
      manifest,
      platform: { kind: this.options.platform.kind, os: this.options.platform.os },
      use: (token) => {
        checkAccess(token);
        const service = this.services.get(token);
        if (service === undefined) {
          throw new Error(
            `Service '${token.id}' is not available to '${manifest.id}'. Is its plugin listed in dependencies?`,
          );
        }
        return service;
      },
      tryUse: (token) => {
        checkAccess(token);
        return this.services.get(token);
      },
      provide: (token, implementation) =>
        store.add(this.services.provide(token, implementation, manifest.id)),
      register: (d) => store.add(d),
      commands: this.commands.api((d) => store.add(d)),
      settings,
      storage: {
        get: (key) => this.options.platform.storage.get(`plugin:${manifest.id}:${key}`),
        set: (key, value) =>
          this.options.platform.storage.set(`plugin:${manifest.id}:${key}`, value),
        delete: (key) => this.options.platform.storage.delete(`plugin:${manifest.id}:${key}`),
      },
      log,
      activate: (event) => this.activateByEvent(event),
    };
  }

  private resolveReplacements(): void {
    for (const entry of this.plugins.values()) {
      for (const replaced of entry.manifest.replaces ?? []) {
        const target = this.plugins.get(replaced);
        if (!target) continue;
        target.state = 'replaced';
        target.replacedBy = entry.manifest.id;
        this.aliases.set(replaced, entry.manifest.id);
      }
    }
  }

  private resolveId(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  private validate(entry: InternalEntry): Error | undefined {
    const m = entry.manifest;
    if (!semver.satisfies(API_VERSION, m.api)) {
      return new Error(`Requires @pumice/api ${m.api}, kernel implements ${API_VERSION}`);
    }
    if (m.platforms && !m.platforms.includes(this.options.platform.kind)) {
      return new Error(`Not available on ${this.options.platform.kind}`);
    }
    for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
      const resolved = this.resolveId(dep);
      const target = this.plugins.get(resolved);
      if (!target) return new Error(`Missing dependency '${dep}'`);
      // A replacement has its own versioning; only check ranges against the original plugin.
      if (resolved === dep && !semver.satisfies(target.manifest.version, range)) {
        return new Error(
          `Dependency '${dep}' ${target.manifest.version} does not satisfy ${range}`,
        );
      }
    }
    return undefined;
  }

  private detectCycles(): void {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string, path: string[]): void => {
      if (done.has(id)) return;
      const entry = this.plugins.get(id);
      if (!entry) return;
      if (visiting.has(id)) {
        const cycle = [...path.slice(path.indexOf(id)), id].join(' → ');
        for (const member of path.slice(path.indexOf(id))) {
          const e = this.plugins.get(member);
          if (e) this.fail(e, new Error(`Dependency cycle: ${cycle}`));
        }
        return;
      }
      visiting.add(id);
      for (const dep of Object.keys(entry.manifest.dependencies ?? {}))
        visit(this.resolveId(dep), [...path, id]);
      visiting.delete(id);
      done.add(id);
    };
    for (const id of this.plugins.keys()) visit(id, []);
  }

  private dependentsOf(id: string): InternalEntry[] {
    return [...this.plugins.values()].filter(
      (e) =>
        e.state === 'active' &&
        [
          ...Object.keys(e.manifest.dependencies ?? {}),
          ...Object.keys(e.manifest.optionalDependencies ?? {}),
        ].some((dep) => this.resolveId(dep) === id),
    );
  }

  private fail(entry: InternalEntry, error: Error): void {
    entry.state = 'failed';
    entry.error = error;
    this.log(entry.manifest.id, 'error', [error.message]);
    // Dependents can never activate now.
    for (const other of this.plugins.values()) {
      if (other.state !== 'registered') continue;
      if (
        Object.keys(other.manifest.dependencies ?? {}).some(
          (d) => this.resolveId(d) === entry.manifest.id,
        )
      ) {
        this.fail(other, new Error(`Dependency '${entry.manifest.id}' failed`));
      }
    }
  }

  private logger(pluginId: string): Logger {
    return {
      debug: (...args) => this.log(pluginId, 'debug', args),
      info: (...args) => this.log(pluginId, 'info', args),
      warn: (...args) => this.log(pluginId, 'warn', args),
      error: (...args) => this.log(pluginId, 'error', args),
    };
  }

  private log(pluginId: string, level: keyof Logger, args: unknown[]): void {
    if (this.options.log) this.options.log(pluginId, level, args);
    else console[level](`[${pluginId}]`, ...args);
  }
}

function isStartup(manifest: PluginManifest): boolean {
  return (
    !manifest.activation ||
    manifest.activation.length === 0 ||
    manifest.activation.includes('onStartup')
  );
}
