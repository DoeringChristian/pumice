import { defineService, definePlugin, PlatformService, type PluginManifest } from '@pumice/api';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it, vi } from 'vitest';
import { Kernel, MemorySettingsBackend } from '../src';

const Greeter = defineService<{ greet(name: string): string }>('test.greeter');

function manifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '1.0.0', api: '^0.1.0', ...extra };
}

function kernel() {
  return new Kernel({
    platform: createMemoryPlatform({ os: 'macos' }),
    settings: new MemorySettingsBackend(),
    log: () => undefined,
  });
}

describe('Kernel', () => {
  it('activates dependencies first and wires services', async () => {
    const k = kernel();
    const order: string[] = [];
    k.addPlugin({
      manifest: manifest('b', { dependencies: { a: '^1.0.0' } }),
      load: () =>
        definePlugin({
          activate(ctx) {
            order.push('b');
            expect(ctx.use(Greeter).greet('x')).toBe('hi x');
          },
        }),
    });
    k.addPlugin({
      manifest: manifest('a'),
      load: () =>
        definePlugin({
          activate(ctx) {
            order.push('a');
            ctx.provide(Greeter, { greet: (n) => `hi ${n}` });
          },
        }),
    });
    await k.start();
    expect(order).toEqual(['a', 'b']);
    expect(k.get('b')?.state).toBe('active');
  });

  it('activates lazy plugins on events and lazy commands', async () => {
    const k = kernel();
    const activate = vi.fn((ctx) => {
      ctx.commands.register({ id: 'lazy.run', title: 'Run', run: () => 42 });
    });
    k.addPlugin({
      manifest: manifest('lazy', {
        activation: ['onCommand:lazy.run'],
        contributes: { commands: [{ id: 'lazy.run', title: 'Run' }] },
      }),
      load: () => definePlugin({ activate }),
    });
    await k.start();
    expect(activate).not.toHaveBeenCalled();
    expect(k.commands.list().map((c) => [c.id, c.lazy])).toEqual([['lazy.run', true]]);
    expect(await k.commands.execute('lazy.run')).toBe(42);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('lets a plugin replace another one', async () => {
    const k = kernel();
    k.addPlugin({
      manifest: manifest('core.search'),
      load: () =>
        definePlugin({ activate: (ctx) => void ctx.provide(Greeter, { greet: () => 'core' }) }),
    });
    k.addPlugin({
      manifest: manifest('better.search', { replaces: ['core.search'] }),
      load: () =>
        definePlugin({ activate: (ctx) => void ctx.provide(Greeter, { greet: () => 'better' }) }),
    });
    let result = '';
    k.addPlugin({
      manifest: manifest('consumer', { dependencies: { 'core.search': '^1.0.0' } }),
      load: () => definePlugin({ activate: (ctx) => void (result = ctx.use(Greeter).greet('')) }),
    });
    await k.start();
    expect(result).toBe('better');
    expect(k.list().find((p) => p.manifest.id === 'core.search')?.state).toBe('replaced');
  });

  it('isolates failures and fails dependents', async () => {
    const k = kernel();
    k.addPlugin({
      manifest: manifest('broken'),
      load: () =>
        definePlugin({
          activate() {
            throw new Error('boom');
          },
        }),
    });
    k.addPlugin({
      manifest: manifest('dependent', { dependencies: { broken: '*' } }),
      load: () => definePlugin({ activate() {} }),
    });
    k.addPlugin({ manifest: manifest('fine'), load: () => definePlugin({ activate() {} }) });
    k.addPlugin({
      manifest: manifest('missing', { dependencies: { nope: '*' } }),
      load: () => definePlugin({ activate() {} }),
    });
    k.addPlugin({
      manifest: manifest('old', { api: '^9.0.0' }),
      load: () => definePlugin({ activate() {} }),
    });
    await k.start();
    const states = Object.fromEntries(k.list().map((p) => [p.manifest.id, p.state]));
    expect(states).toEqual({
      broken: 'failed',
      dependent: 'failed',
      fine: 'active',
      missing: 'failed',
      old: 'failed',
    });
  });

  it('detects dependency cycles', async () => {
    const k = kernel();
    k.addPlugin({
      manifest: manifest('x', { dependencies: { y: '*' } }),
      load: () => definePlugin({ activate() {} }),
    });
    k.addPlugin({
      manifest: manifest('y', { dependencies: { x: '*' } }),
      load: () => definePlugin({ activate() {} }),
    });
    await k.start();
    expect(k.get('x')?.error?.message).toMatch(/cycle/);
  });

  it('disposes registrations on deactivate, dependents first', async () => {
    const k = kernel();
    const disposed: string[] = [];
    k.addPlugin({
      manifest: manifest('base'),
      load: () =>
        definePlugin({ activate: (ctx) => void ctx.register(() => disposed.push('base')) }),
    });
    k.addPlugin({
      manifest: manifest('top', { dependencies: { base: '*' } }),
      load: () =>
        definePlugin({
          activate: (ctx) => {
            ctx.register(() => disposed.push('top'));
            ctx.commands.register({ id: 'top.cmd', title: 'Cmd', run: () => undefined });
          },
        }),
    });
    await k.start();
    await k.deactivate('base');
    expect(disposed).toEqual(['top', 'base']);
    expect(k.commands.list()).toEqual([]);
  });

  it('gates restricted services behind permissions', async () => {
    const k = kernel();
    let error: unknown;
    let kind: string | undefined;
    k.addPlugin({
      manifest: manifest('nosy'),
      load: () =>
        definePlugin({
          activate: (ctx) => void (error = catchError(() => ctx.use(PlatformService))),
        }),
    });
    k.addPlugin({
      manifest: manifest('infra', { permissions: ['platform'] }),
      load: () => definePlugin({ activate: (ctx) => void (kind = ctx.use(PlatformService).kind) }),
    });
    await k.start();
    expect(String(error)).toMatch(/permission/);
    expect(kind).toBe('web');
  });

  it('runs commands from hotkeys', async () => {
    const k = kernel();
    const run = vi.fn();
    k.addPlugin({
      manifest: manifest('keys'),
      load: () =>
        definePlugin({
          activate: (ctx) =>
            void ctx.commands.register({ id: 'k', title: 'K', hotkeys: ['Mod+Shift+P'], run }),
        }),
    });
    await k.start();
    const event = {
      key: 'P',
      code: 'KeyP',
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      preventDefault: vi.fn(),
    };
    expect(k.commands.handleKeyEvent(event as unknown as KeyboardEvent)).toBe(true);
    await Promise.resolve();
    expect(run).toHaveBeenCalled();
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('Kernel plugin management', () => {
  const provider = (greeting: string, log: string[]) =>
    definePlugin({
      activate(ctx) {
        log.push(`a:${greeting}`);
        ctx.provide(Greeter, { greet: (n) => `${greeting} ${n}` });
      },
      deactivate() {
        log.push('a:off');
      },
    });
  const consumer = (log: string[]) =>
    definePlugin({
      activate(ctx) {
        log.push(`b:${ctx.use(Greeter).greet('x')}`);
      },
      deactivate() {
        log.push('b:off');
      },
    });

  it('disables with dependents, re-enables, and persists the disabled set', async () => {
    const log: string[] = [];
    let persisted: string[] = [];
    const k = new Kernel({
      platform: createMemoryPlatform({ os: 'macos' }),
      settings: new MemorySettingsBackend(),
      log: () => undefined,
      onDisabledChange: (d) => void (persisted = d),
      required: ['core'],
    });
    k.addPlugin({ manifest: manifest('a'), load: () => provider('hi', log) });
    k.addPlugin({
      manifest: manifest('b', { dependencies: { a: '^1.0.0' } }),
      load: () => consumer(log),
    });
    k.addPlugin({ manifest: manifest('core'), load: () => definePlugin({ activate() {} }) });
    await k.start();
    await k.disable('a');
    expect(log).toEqual(['a:hi', 'b:hi x', 'b:off', 'a:off']);
    expect(persisted).toEqual(['a']);
    await expect(k.activate('a')).rejects.toThrow(/turned off/);
    await expect(k.disable('core')).rejects.toThrow(/required/);
    await k.enable('a');
    expect(k.get('a')?.state).toBe('active');
    expect(persisted).toEqual([]);
  });

  it('starts with disabled plugins off', async () => {
    const k = new Kernel({
      platform: createMemoryPlatform({ os: 'macos' }),
      settings: new MemorySettingsBackend(),
      log: () => undefined,
      disabled: ['a'],
    });
    const log: string[] = [];
    k.addPlugin({ manifest: manifest('a'), load: () => provider('hi', log) });
    await k.start();
    expect(k.get('a')?.state).toBe('disabled');
    expect(log).toEqual([]);
  });

  it('installs and hot-reloads plugins while running, re-activating dependents', async () => {
    const log: string[] = [];
    const k = kernel();
    k.addPlugin({ manifest: manifest('a'), load: () => provider('hi', log) });
    await k.start();
    await k.install({
      manifest: manifest('b', { dependencies: { a: '^1.0.0' } }),
      load: () => consumer(log),
    });
    expect(log).toEqual(['a:hi', 'b:hi x']);
    await k.install({
      manifest: manifest('a', { version: '1.1.0' }),
      load: () => provider('hello', log),
    });
    expect(log).toEqual(['a:hi', 'b:hi x', 'b:off', 'a:off', 'a:hello', 'b:hello x']);
    await k.uninstall('b');
    expect(k.get('b')).toBeUndefined();
  });
});
