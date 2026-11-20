import type { PluginManifest } from '../manifest';
import { defineService } from '../service';

export interface PluginInfo {
  manifest: PluginManifest;
  state:
    | 'registered'
    | 'replaced'
    | 'activating'
    | 'active'
    | 'deactivating'
    | 'inactive'
    | 'failed'
    | 'disabled';
  error?: string;
  activationMs?: number;
  replacedBy?: string;
}

/** Installed plugins (provided by the kernel). */
export interface PluginsApi {
  list(): PluginInfo[];
  /** Turns a plugin on or off now (and remembers it for the next start). */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Plugins the app can't run without. */
  isRequired(id: string): boolean;
}

export const Plugins = defineService<PluginsApi>('kernel.plugins');
