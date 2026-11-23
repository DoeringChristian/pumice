import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel, MemorySettingsBackend } from '@pumice/kernel';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it } from 'vitest';
import { PluginManager, pluginSources } from '../src/plugin-manager';
import { exposeSharedModules } from '../src/shared-modules';

const CLI = join(import.meta.dirname, '../../plugin-cli/bin/pumice-plugin.mjs');

function buildPlugin(greeting: string): { manifest: string; main: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pumice-plugin-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: 'test.hello', name: 'Hello', version: '1.0.0', api: '^0.1.0' }),
  );
  writeFileSync(
    join(dir, 'src/main.ts'),
    `import { definePlugin } from '@pumice/api';
export default definePlugin({
  activate(ctx) {
    ctx.commands.register({ id: 'test.hello', title: 'Hello', run: () => ${JSON.stringify(greeting)} });
  },
});`,
  );
  execFileSync(process.execPath, [CLI, 'build', dir], { stdio: 'pipe' });
  return {
    manifest: readFileSync(join(dir, 'dist/manifest.json'), 'utf8'),
    main: readFileSync(join(dir, 'dist/main.js'), 'utf8'),
  };
}

describe('community plugins', () => {
  it('builds with the CLI, installs, runs, reloads and uninstalls', async () => {
    exposeSharedModules();
    const platform = createMemoryPlatform({ os: 'macos' });
    const kernel = new Kernel({
      platform,
      settings: new MemorySettingsBackend(),
      log: () => undefined,
    });
    const manager = new PluginManager(kernel, platform);
    await manager.discover();
    await kernel.start();

    const v1 = buildPlugin('hi');
    // The bundle doesn't contain the API: it uses the app's shared copy.
    expect(v1.main).not.toContain('micromark');
    await manager.install(v1);
    expect(await kernel.commands.api(() => undefined).execute('test.hello')).toBe('hi');
    expect(platform.fs.snapshot()['.pumice/extensions/test.hello/manifest.json']).toBeTruthy();

    // A rebuild on disk reloads the plugin.
    const v2 = buildPlugin('hello again');
    await platform.fs.write('.pumice/extensions/test.hello/main.js', v2.main);
    await manager.reload('test.hello');
    expect(await kernel.commands.api(() => undefined).execute('test.hello')).toBe('hello again');

    // Discovered on the next start.
    const kernel2 = new Kernel({
      platform,
      settings: new MemorySettingsBackend(),
      log: () => undefined,
    });
    const manager2 = new PluginManager(kernel2, platform);
    await manager2.discover();
    await kernel2.start();
    expect(kernel2.get('test.hello')?.state).toBe('active');

    await manager.uninstall('test.hello');
    expect(kernel.get('test.hello')).toBeUndefined();
    expect(
      Object.keys(platform.fs.snapshot()).some((p) =>
        p.startsWith('.pumice/extensions/test.hello/'),
      ),
    ).toBe(false);
  }, 30_000);

  it('rejects invalid manifests and core ids', async () => {
    const platform = createMemoryPlatform({ os: 'macos' });
    const kernel = new Kernel({
      platform,
      settings: new MemorySettingsBackend(),
      log: () => undefined,
    });
    const manager = new PluginManager(kernel, platform);
    await kernel.start();
    await expect(
      manager.install({
        manifest: '{"id":"core.vault","name":"x","version":"1","api":"^0.1.0"}',
        main: '',
      }),
    ).rejects.toThrow(/core/);
    await expect(manager.install({ manifest: '{"id":"x"}', main: '' })).rejects.toThrow(/missing/);
  });
});

describe('where a plugin is installed from', () => {
  it('installs author/repo from the repository when it has no release', async () => {
    exposeSharedModules();
    const platform = createMemoryPlatform({ os: 'macos' });
    const kernel = new Kernel({
      platform,
      settings: new MemorySettingsBackend(),
      log: () => undefined,
    });
    const manager = new PluginManager(kernel, platform);
    await manager.discover();
    await kernel.start();
    const built = buildPlugin('from the repository');
    const asked: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      asked.push(url);
      const base = 'https://raw.githubusercontent.com/ada/hello/HEAD/dist/';
      const body =
        url === `${base}manifest.json`
          ? built.manifest
          : url === `${base}main.js`
            ? built.main
            : undefined;
      // The host answers for a missing release with a page, not with an error.
      if (url.includes('/releases/'))
        return new Response('<!doctype html><p>Not found', { status: 200 });
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }) as typeof fetch;
    try {
      const manifest = await manager.installFromUrl('ada/hello');
      expect(manifest.id).toBe('test.hello');
      expect(await kernel.commands.api(() => undefined).execute('test.hello')).toBe(
        'from the repository',
      );
      expect(asked[0]).toBe('https://github.com/ada/hello/releases/latest/download/manifest.json');
      await expect(manager.installFromUrl('ada/nothing-here')).rejects.toThrow(
        /No plugin was found/,
      );
      await expect(manager.installFromUrl('nonsense')).rejects.toThrow(/author\/repo/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('reads author/repo as a repository on GitHub: latest release, then its files', () => {
    expect(pluginSources('ada/pumice-clock')).toEqual([
      'https://github.com/ada/pumice-clock/releases/latest/download/',
      'https://raw.githubusercontent.com/ada/pumice-clock/HEAD/',
      'https://raw.githubusercontent.com/ada/pumice-clock/HEAD/dist/',
    ]);
    expect(pluginSources(' ada/pumice-clock@v1.2 ')[0]).toBe(
      'https://github.com/ada/pumice-clock/releases/download/v1.2/',
    );
  });
  it('reads the address of a GitHub repository in the forms it comes in', () => {
    const plain = pluginSources('ada/clock');
    expect(pluginSources('https://github.com/ada/clock')).toEqual(plain);
    expect(pluginSources('https://github.com/ada/clock.git')).toEqual(plain);
    expect(pluginSources('git@github.com:ada/clock.git')).toEqual(plain);
    expect(pluginSources('https://github.com/ada/clock/tree/dev')[1]).toBe(
      'https://raw.githubusercontent.com/ada/clock/dev/',
    );
    expect(pluginSources('https://github.com/ada/clock/releases/tag/v2')[0]).toBe(
      'https://github.com/ada/clock/releases/download/v2/',
    );
  });
  it('reads a repository on another host, and a plain folder', () => {
    const other = pluginSources('https://codeberg.org/ada/clock.git');
    expect(other).toContain('https://codeberg.org/ada/clock/raw/branch/main/');
    expect(other).toContain('https://codeberg.org/ada/clock/-/raw/HEAD/dist/');
    expect(other).not.toContain('https://codeberg.org/ada/clock.git/');
    expect(pluginSources('https://example.org/plugins/clock/1.0/')[0]).toBe(
      'https://example.org/plugins/clock/1.0/',
    );
    expect(pluginSources('http://localhost:8080/clock')).toEqual(['http://localhost:8080/clock/']);
  });
  it('takes nothing that is not https or a repository', () => {
    expect(pluginSources('http://example.org/a/b')).toEqual([]);
    expect(pluginSources('just-a-name')).toEqual([]);
    expect(pluginSources('')).toEqual([]);
  });
});
