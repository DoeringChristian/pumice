import type { Disposable, ServiceToken } from '@pumice/api';

interface Entry {
  implementation: unknown;
  pluginId: string;
}

export class ServiceRegistry {
  private entries = new Map<string, Entry>();

  provide<T>(token: ServiceToken<T>, implementation: T, pluginId: string): Disposable {
    const existing = this.entries.get(token.id);
    if (existing) {
      throw new Error(
        `Service '${token.id}' is already provided by '${existing.pluginId}' (attempted by '${pluginId}')`,
      );
    }
    const entry = { implementation, pluginId };
    this.entries.set(token.id, entry);
    return {
      dispose: () => {
        if (this.entries.get(token.id) === entry) this.entries.delete(token.id);
      },
    };
  }

  get<T>(token: ServiceToken<T>): T | undefined {
    return this.entries.get(token.id)?.implementation as T | undefined;
  }

  providerOf(token: ServiceToken<unknown>): string | undefined {
    return this.entries.get(token.id)?.pluginId;
  }
}
