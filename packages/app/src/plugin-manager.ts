import {
  Emitter,
  type InstalledPlugin,
  type PluginDefinition,
  type PluginFiles,
  type PluginManagerApi,
  type PluginManifest,
} from '@pumice/api';
import type { Kernel } from '@pumice/kernel';
import type { Platform } from '@pumice/platform';

/** Where community plugins live inside the vault. */
export const EXTENSIONS_DIR = '.pumice/extensions';
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function parseManifest(text: string): PluginManifest {
  const m = JSON.parse(text) as PluginManifest;
  if (!m || typeof m !== 'object') throw new Error('manifest.json is not an object');
  for (const key of ['id', 'name', 'version', 'api'] as const) {
    if (typeof m[key] !== 'string' || !m[key]) throw new Error(`manifest.json is missing "${key}"`);
  }
  if (!ID_PATTERN.test(m.id)) throw new Error(`Invalid plugin id "${m.id}"`);
  if (m.id.startsWith('core.')) throw new Error('Community plugins cannot use the "core." prefix');
  return m;
}

/** Loads a plugin bundle (an ES module) from source text. */
async function importModule(code: string): Promise<PluginDefinition> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    } catch (e) {
      // Runtimes that can't import blob: URLs (Node, tests) take a data: URL.
      if (
        !(e instanceof Error) ||
        !/blob|scheme|protocol|ERR_UNSUPPORTED/i.test(
          `${e.message} ${(e as { code?: string }).code ?? ''}`,
        )
      )
        throw e;
      mod = (await import(
        /* @vite-ignore */ `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`
      )) as Record<string, unknown>;
    }
    const candidate =
      (mod.default as { plugin?: unknown } | undefined)?.plugin ?? mod.plugin ?? mod.default;
    if (!candidate || typeof (candidate as PluginDefinition).activate !== 'function') {
      throw new Error('main.js must export a plugin (export default definePlugin({ activate … }))');
    }
    return candidate as PluginDefinition;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class PluginManager implements PluginManagerApi {
  private readonly plugins = new Map<string, InstalledPlugin>();
  private readonly styles = new Map<string, HTMLStyleElement>();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly kernel: Kernel,
    private readonly platform: Platform,
  ) {}

  installed(): InstalledPlugin[] {
    return [...this.plugins.values()];
  }

  /** Registers every plugin found in the vault (before the kernel starts). */
  async discover(): Promise<void> {
    const entries = await this.platform.fs.list().catch(() => []);
    const manifests = entries.filter((e) => {
      const parts = e.path.split('/');
      return (
        e.kind === 'file' &&
        e.path.startsWith(`${EXTENSIONS_DIR}/`) &&
        parts.length === 4 &&
        parts[3] === 'manifest.json'
      );
    });
    for (const entry of manifests) {
      const folder = entry.path.slice(0, -'/manifest.json'.length);
      try {
        const manifest = parseManifest(await this.platform.fs.readText(entry.path));
        this.plugins.set(manifest.id, { manifest, folder });
        this.kernel.addPlugin({ manifest, load: () => this.load(manifest.id) });
      } catch (e) {
        console.error(`[pumice] could not load plugin in ${folder}:`, e);
      }
    }
    // Rebuilt plugins (plugin-cli dev) reload by themselves.
    this.platform.watcher?.watch((events) => {
      for (const ev of events) {
        const m = new RegExp(
          `^${EXTENSIONS_DIR}/([^/]+)/(main\\.js|styles\\.css|manifest\\.json)$`,
        ).exec(ev.path);
        if (!m) continue;
        const id = [...this.plugins.values()].find((p) => p.folder === `${EXTENSIONS_DIR}/${m[1]}`)
          ?.manifest.id;
        if (!id) continue;
        clearTimeout(this.reloadTimers.get(id));
        this.reloadTimers.set(
          id,
          setTimeout(() => void this.reload(id).catch((e) => console.error(e)), 200),
        );
      }
    });
  }

  private async load(id: string): Promise<PluginDefinition> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`Plugin '${id}' is not installed`);
    const code = await this.platform.fs.readText(`${plugin.folder}/main.js`);
    const definition = await importModule(code);
    let css: string | undefined;
    try {
      css = await this.platform.fs.readText(`${plugin.folder}/styles.css`);
    } catch {
      css = undefined;
    }
    // Styles live as long as the plugin is active.
    return {
      activate: async (ctx) => {
        if (css) {
          const style = document.createElement('style');
          style.dataset.plugin = id;
          style.textContent = css;
          document.head.append(style);
          this.styles.set(id, style);
          ctx.register(() => {
            style.remove();
            this.styles.delete(id);
          });
        }
        await definition.activate(ctx);
      },
      ...(definition.deactivate ? { deactivate: definition.deactivate } : {}),
    };
  }

  async install(files: PluginFiles): Promise<PluginManifest> {
    const manifest = parseManifest(files.manifest);
    // Validate the bundle before writing anything.
    await importModule(files.main);
    const folder = `${EXTENSIONS_DIR}/${manifest.id}`;
    await this.platform.fs.mkdir(folder);
    await this.platform.fs.write(`${folder}/manifest.json`, files.manifest);
    await this.platform.fs.write(`${folder}/main.js`, files.main);
    if (files.styles !== undefined)
      await this.platform.fs.write(`${folder}/styles.css`, files.styles);
    this.plugins.set(manifest.id, { manifest, folder });
    await this.kernel.install({ manifest, load: () => this.load(manifest.id) });
    this.changed.fire();
    return manifest;
  }

  async installFromUrl(baseUrl: string): Promise<PluginManifest> {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    if (!/^https:\/\//i.test(base) && !/^http:\/\/localhost[:/]/i.test(base)) {
      throw new Error('Plugins can only be installed over https');
    }
    const fetchText =
      this.platform.net?.fetchText ??
      (async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      });
    const [manifest, main] = await Promise.all([
      fetchText(`${base}manifest.json`),
      fetchText(`${base}main.js`),
    ]);
    const styles = await fetchText(`${base}styles.css`).catch(() => undefined);
    return this.install({ manifest, main, ...(styles !== undefined ? { styles } : {}) });
  }

  async uninstall(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    await this.kernel.uninstall(id);
    await this.platform.fs.remove(plugin.folder, { trash: true });
    this.plugins.delete(id);
    this.changed.fire();
  }

  async reload(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    const manifest = parseManifest(
      await this.platform.fs.readText(`${plugin.folder}/manifest.json`),
    );
    this.plugins.set(id, { manifest, folder: plugin.folder });
    await this.kernel.install({ manifest, load: () => this.load(id) });
    console.info(`[pumice] reloaded plugin ${id}`);
    this.changed.fire();
  }
}
