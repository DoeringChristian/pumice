import {
  PluginManager as PluginManagerService,
  WorkspaceShell,
  type PluginModule,
} from '@pumice/api';
import agents from '@pumice/core-agents';
import backlinks from '@pumice/core-backlinks';
import collab from '@pumice/core-collab';
import comments from '@pumice/core-comments';
import daily from '@pumice/core-daily';
import diagnostics from '@pumice/core-diagnostics';
import documents from '@pumice/core-documents';
import editor from '@pumice/core-editor';
import excalidraw from '@pumice/core-excalidraw';
import explorer from '@pumice/core-explorer';
import files from '@pumice/core-files';
import frames from '@pumice/core-frames';
import graph from '@pumice/core-graph';
import ids from '@pumice/core-ids';
import index from '@pumice/core-index';
import links from '@pumice/core-links';
import markdown from '@pumice/core-markdown';
import media from '@pumice/core-media';
import outline from '@pumice/core-outline';
import pdf from '@pumice/core-pdf';
import palette from '@pumice/core-palette';
import properties from '@pumice/core-properties';
import reader from '@pumice/core-reader';
import search from '@pumice/core-search';
import settings from '@pumice/core-settings';
import switcher from '@pumice/core-switcher';
import tables from '@pumice/core-tables';
import tags from '@pumice/core-tags';
import templates from '@pumice/core-templates';
import theme from '@pumice/core-theme';
import vault from '@pumice/core-vault';
import vaults from '@pumice/core-vaults';
import workspace from '@pumice/core-workspace';
import { Kernel } from '@pumice/kernel';
import type { Platform } from '@pumice/platform';
import { PluginManager } from './plugin-manager';
import { exposeSharedModules } from './shared-modules';
import { VaultSettingsBackend } from './settings-backend';

export { VaultSettingsBackend } from './settings-backend';
export { PluginManager, EXTENSIONS_DIR } from './plugin-manager';

/** Plugins shipped with the app. Order doesn't matter: the kernel resolves dependencies. */
export const bundledPlugins: PluginModule[] = [
  vault,
  documents,
  markdown,
  index,
  workspace,
  editor,
  reader,
  links,
  ids,
  files,
  media,
  frames,
  pdf,
  vaults,
  explorer,
  switcher,
  palette,
  search,
  backlinks,
  outline,
  tags,
  properties,
  excalidraw,
  graph,
  collab,
  templates,
  tables,
  comments,
  agents,
  daily,
  settings,
  theme,
  diagnostics,
];

export interface AppOptions {
  platform: Platform;
  root: HTMLElement;
  /** Extra plugins (development, tests). */
  plugins?: PluginModule[];
}

/** Plugins the app can't run without (docs/plan/02: replaceable, not removable). */
export const REQUIRED_PLUGINS = ['core.vault', 'core.documents', 'core.markdown', 'core.workspace'];
const PLUGIN_STATE = '.pumice/plugins.json';

async function readDisabled(platform: Platform): Promise<string[]> {
  try {
    if (!(await platform.fs.stat(PLUGIN_STATE))) return [];
    const data = JSON.parse(await platform.fs.readText(PLUGIN_STATE)) as { disabled?: unknown };
    return Array.isArray(data.disabled)
      ? data.disabled.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function startApp({ platform, root, plugins = [] }: AppOptions): Promise<Kernel> {
  // Lets styles adapt to the shell (e.g. room for the macOS window buttons).
  document.documentElement.dataset.platform = platform.kind;
  document.documentElement.dataset.os = platform.os;
  const kernel = new Kernel({
    platform,
    settings: new VaultSettingsBackend(platform.fs),
    disabled: await readDisabled(platform),
    required: REQUIRED_PLUGINS,
    onDisabledChange: async (disabled) => {
      await platform.fs.mkdir('.pumice');
      await platform.fs.write(PLUGIN_STATE, `${JSON.stringify({ disabled }, null, 2)}\n`);
    },
  });
  for (const module of [...bundledPlugins, ...plugins]) {
    kernel.addPlugin({ manifest: module.manifest, load: () => module.plugin });
  }
  exposeSharedModules();
  const manager = new PluginManager(kernel, platform);
  await manager.discover();
  kernel.services.provide(PluginManagerService, manager, 'app');
  await kernel.start();

  const failed = kernel.list().filter((p) => p.state === 'failed');
  for (const p of failed) console.error(`[pumice] plugin ${p.manifest.id} failed:`, p.error);

  const shell = kernel.services.get(WorkspaceShell);
  if (!shell) {
    root.textContent = 'Pumice could not start: no workspace plugin is active.';
    root.className = 'pm-fatal';
    return kernel;
  }
  document.title = platform.vaultName;
  shell.mount(root, { vaultName: platform.vaultName });
  return kernel;
}
