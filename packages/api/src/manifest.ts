import type { PlatformKind } from '@pumice/platform';

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
}

export interface FileTypeContribution {
  /** File type id, used in `onFileType:<id>` activation events. */
  id: string;
  /** Matched against the end of the file name, longest match wins: `md`, `excalidraw.md`. */
  extensions: string[];
}

export interface ViewContribution {
  type: string;
  title: string;
}

export interface PluginManifest {
  /** Reverse-DNS-like unique id: `core.editor`, `acme.kanban`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Supported @pumice/api range. */
  api: string;
  platforms?: PlatformKind[];
  /** plugin id → semver range. Dependencies are activated first. */
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** Plugin ids this plugin stands in for: dependents of those resolve to this plugin. */
  replaces?: string[];
  /**
   * Activation events. Omitted or containing `onStartup` → activated at startup.
   * Otherwise lazily: `onCommand:<id>`, `onFileType:<id>`, `onView:<type>`.
   */
  activation?: string[];
  contributes?: {
    commands?: CommandContribution[];
    fileTypes?: FileTypeContribution[];
    views?: ViewContribution[];
  };
  /** Sensitive capabilities: `platform`, `network`, `clipboard`, `shell`. */
  permissions?: string[];
}
