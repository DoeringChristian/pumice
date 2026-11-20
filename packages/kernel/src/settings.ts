import { Emitter, type PluginSettings } from '@pumice/api';

export interface SettingsBackend {
  load(pluginId: string): Promise<Record<string, unknown> | undefined>;
  save(pluginId: string, data: Record<string, unknown>): Promise<void>;
}

export class MemorySettingsBackend implements SettingsBackend {
  readonly data = new Map<string, Record<string, unknown>>();
  async load(pluginId: string) {
    return this.data.get(pluginId);
  }
  async save(pluginId: string, data: Record<string, unknown>) {
    this.data.set(pluginId, structuredClone(data));
  }
}

export class PluginSettingsStore implements PluginSettings {
  private values: Record<string, unknown> = {};
  private readonly changed = new Emitter<string>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly pluginId: string,
    private readonly backend: SettingsBackend,
  ) {}

  async load(): Promise<void> {
    this.values = (await this.backend.load(this.pluginId)) ?? {};
  }

  get<T>(key: string, fallback: T): T {
    return key in this.values ? (this.values[key] as T) : fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values = { ...this.values, [key]: value };
    this.changed.fire(key);
    await this.backend.save(this.pluginId, this.values);
  }
}
