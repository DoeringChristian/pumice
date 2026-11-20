import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel, MemorySettingsBackend } from '@pumice/kernel';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it } from 'vitest';
import { PluginManager } from '../src/plugin-manager';
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
