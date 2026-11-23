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

  /**
   * Installs a plugin from where it is published: `author/repo` on GitHub, the address of a
   * git repository on any host, or the address of a folder that holds the plugin's files.
   */
  async installFromUrl(source: string): Promise<PluginManifest> {
    const candidates = pluginSources(source);
    if (!candidates.length)
      throw new Error(
        'Give a GitHub repository as author/repo, or the full https address of a repository.',
      );
    const fetchText =
      this.platform.net?.fetchText ??
      (async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      });
    for (const base of candidates) {
      let manifest: string;
      let main: string;
      try {
        [manifest, main] = await Promise.all([
          fetchText(`${base}manifest.json`),
          fetchText(`${base}main.js`),
        ]);
        // A host answers for what is not there with a page of its own.
        parseManifest(manifest);
      } catch {
        continue;
      }
      const styles = await fetchText(`${base}styles.css`).catch(() => undefined);
      return this.install({
        manifest,
        main,
        ...(styles !== undefined && !/^\s*<(!doctype|html)/i.test(styles) ? { styles } : {}),
      });
    }
    throw new Error(
      `No plugin was found at ${source.trim()}: manifest.json and main.js are looked for in the repository's latest release, and in the repository itself (at its top, or in dist/).`,
    );
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

/**
 * Where the files of a plugin may be, for what a user gives as its source, in the order they
 * are tried (each a folder address ending in `/`):
 *
 * - `author/repo` (also `author/repo@v1.2`): a repository on GitHub;
 * - the address of a repository on GitHub, GitLab, Codeberg or another host (as it is cloned
 *   or as the browser shows it, also `git@host:author/repo.git`);
 * - the address of a folder that holds `manifest.json` and `main.js`.
 *
 * A repository is looked at without git: its latest release first (GitHub), then the files
 * as the host hands them out, at the top of the repository and in `dist/`.
 */
export function pluginSources(input: string): string[] {
  let source = input.trim();
  if (!source) return [];
  // author/repo, with a release or branch after @ or #.
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[@#]([\w./-]+))?$/.exec(source);
  if (short && !source.includes('://')) return github(short[1]!, short[2]!, short[3]);
  // git@host:author/repo.git and ssh://git@host/author/repo.git, read over https.
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(source);
  if (ssh) source = `https://${ssh[1]}/${ssh[2]}`;
  if (/^git:\/\//i.test(source)) source = source.replace(/^git:/i, 'https:');
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return [];
  }
  const local = url.protocol === 'http:' && url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !local) return [];
  const folder = `${url.origin}${url.pathname.replace(/\/+$/, '')}/`;
  if (local) return [folder];
  const parts = url.pathname.split('/').filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' && parts.length >= 2) {
    const repo = parts[1]!.replace(/\.git$/, '');
    // …/tree/<branch> and …/releases/tag/<tag> name what to take.
    const ref =
      parts[2] === 'tree' ? parts.slice(3).join('/') : parts[3] === 'tag' ? parts[4] : undefined;
    return github(parts[0]!, repo, ref || undefined);
  }
  const out: string[] = [];
  // As it is: a folder with the files in it (a release, a web server).
  if (!/\.git$/.test(url.pathname)) out.push(folder);
  if (parts.length >= 2) {
    const repo = `${url.origin}/${parts.join('/').replace(/\.git$/, '')}`;
    // How hosts hand out a file of a repository: GitLab, then Gitea/Forgejo/Codeberg and
    // Bitbucket, with the branch they call the default one or the usual names for it.
    for (const raw of [
      `${repo}/-/raw/HEAD/`,
      `${repo}/raw/HEAD/`,
      `${repo}/raw/branch/main/`,
      `${repo}/raw/branch/master/`,
      `${repo}/raw/main/`,
      `${repo}/raw/master/`,
    ])
      out.push(raw, `${raw}dist/`);
  }
  return out;
}

function github(owner: string, repo: string, ref?: string): string[] {
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref ?? 'HEAD'}/`;
  return [
    ref
      ? `https://github.com/${owner}/${repo}/releases/download/${ref}/`
      : `https://github.com/${owner}/${repo}/releases/latest/download/`,
    raw,
    `${raw}dist/`,
  ];
}
