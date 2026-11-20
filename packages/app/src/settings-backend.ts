import type { SettingsBackend } from '@pumice/kernel';
import type { PlatformFs } from '@pumice/platform';

/** Vault-scoped plugin settings in `.pumice/plugins/<id>.json`. */
export class VaultSettingsBackend implements SettingsBackend {
  private writes = new Map<string, Promise<unknown>>();

  constructor(private readonly fs: PlatformFs) {}

  private path(pluginId: string): string {
    return `.pumice/plugins/${pluginId}.json`;
  }

  async load(pluginId: string): Promise<Record<string, unknown> | undefined> {
    try {
      if (!(await this.fs.stat(this.path(pluginId)))) return undefined;
      return JSON.parse(await this.fs.readText(this.path(pluginId))) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[pumice] could not read settings of ${pluginId}`, e);
      return undefined;
    }
  }

  save(pluginId: string, data: Record<string, unknown>): Promise<void> {
    // Chain writes per plugin so an older write never lands after a newer one.
    const previous = this.writes.get(pluginId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.fs.write(this.path(pluginId), JSON.stringify(data, null, 2) + '\n'));
    this.writes.set(pluginId, next);
    return next.then(() => undefined);
  }
}
