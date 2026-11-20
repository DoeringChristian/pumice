/**
 * Platform for the iOS/Android app (docs/plan/07): the vault is accessed through the native
 * `PumiceFs` plugin (bulk tree stat, atomic writes); app storage lives in OPFS; lifecycle comes
 * from Capacitor's App plugin. There is no file watcher: core.vault rescans on resume.
 */
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type {
  AppStorage,
  FileStat,
  Platform,
  PlatformFs,
  VaultPath,
  VaultSwitcher,
} from '@pumice/platform';

/** The native side (ios/…/PumiceFsPlugin.swift, android/…/PumiceFsPlugin.kt). */
export interface PumiceFsPlugin {
  /** The vault folder in use, picking a default (app Documents/"Pumice") on first launch. */
  info(): Promise<{ vaultName: string; vaultUri: string }>;
  /** Lets the user choose a folder on the device and switches to it. */
  pickVault(): Promise<{ vaultName: string; vaultUri: string } | { cancelled: true }>;
  /** Vaults in the app's storage plus device folders opened before. */
  listVaults(): Promise<{
    vaults: Array<{ id: string; name: string; location: string; current: boolean }>;
  }>;
  /** Makes a listed vault the current one (takes effect when the app reloads). */
  openVault(opts: { id: string }): Promise<void>;
  /** Creates an empty vault in the app's storage and makes it current. */
  createVault(opts: { name: string }): Promise<void>;
  forgetVault(opts: { id: string }): Promise<void>;
  /** Whole tree in one call: thousands of stats without one bridge round trip each. */
  statTree(): Promise<{ entries: FileStat[] }>;
  stat(opts: { path: string }): Promise<{ entry: FileStat | null }>;
  readText(opts: { path: string }): Promise<{ text: string }>;
  readBinary(opts: { path: string }): Promise<{ base64: string }>;
  /** Atomic: written to a temp file next to the target, then renamed over it. */
  write(opts: { path: string; text?: string; base64?: string }): Promise<{ entry: FileStat }>;
  rename(opts: { from: string; to: string }): Promise<void>;
  /** `trash`: moved to the vault's `.trash` folder (mobile has no system trash for app files). */
  remove(opts: { path: string; trash: boolean }): Promise<void>;
  mkdir(opts: { path: string }): Promise<void>;
  share(opts: { path: string }): Promise<void>;
}

export const PumiceFs = registerPlugin<PumiceFsPlugin>('PumiceFs');

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function capacitorFs(native: PumiceFsPlugin): PlatformFs {
  return {
    list: async () => (await native.statTree()).entries,
    stat: async (path) => (await native.stat({ path })).entry,
    readText: async (path) => (await native.readText({ path })).text,
    readBinary: async (path) => fromBase64((await native.readBinary({ path })).base64),
    write: async (path, data) =>
      (
        await native.write(
          typeof data === 'string' ? { path, text: data } : { path, base64: toBase64(data) },
        )
      ).entry,
    rename: (from, to) => native.rename({ from, to }),
    remove: (path, opts) => native.remove({ path, trash: opts?.trash ?? true }),
    mkdir: (path) => native.mkdir({ path }),
  };
}

/** Key/value storage in the origin-private file system, one file per key. */
export async function opfsStorage(namespace: string): Promise<AppStorage> {
  const fileName = async (key: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return [...new Uint8Array(digest)]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(namespace, { create: true });
    return {
      async get(key) {
        try {
          const handle = await dir.getFileHandle(await fileName(key));
          return await (await handle.getFile()).text();
        } catch {
          return undefined;
        }
      },
      async set(key, value) {
        const handle = await dir.getFileHandle(await fileName(key), { create: true });
        const writable = await handle.createWritable();
        await writable.write(value);
        await writable.close();
      },
      async delete(key) {
        await dir.removeEntry(await fileName(key)).catch(() => undefined);
      },
    };
  } catch {
    // Older WebViews without OPFS: localStorage (small vaults only).
    const prefix = `${namespace}:`;
    return {
      get: async (key) => localStorage.getItem(prefix + key) ?? undefined,
      set: async (key, value) => localStorage.setItem(prefix + key, value),
      delete: async (key) => localStorage.removeItem(prefix + key),
    };
  }
}

export async function createCapacitorPlatform(
  native: PumiceFsPlugin = PumiceFs,
): Promise<Platform> {
  const info = await native.info();
  const pause = new Set<() => void>();
  const resume = new Set<() => void>();
  void App.addListener('pause', () => pause.forEach((l) => l()));
  void App.addListener('resume', () => resume.forEach((l) => l()));
  /** The app shows one vault at a time: save what is pending, then start over on the new one. */
  const restart = async () => {
    pause.forEach((l) => l());
    await new Promise((r) => setTimeout(r, 300));
    location.reload();
  };
  const os =
    Capacitor.getPlatform() === 'ios'
      ? 'ios'
      : Capacitor.getPlatform() === 'android'
        ? 'android'
        : 'unknown';
  const storageKey = await crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(info.vaultUri))
    .then((d) =>
      [...new Uint8Array(d)]
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    );
  const vaults: VaultSwitcher = {
    list: async () => (await native.listVaults()).vaults,
    open: async (id) => {
      await native.openVault({ id });
      await restart();
    },
    pick: async () => {
      const picked = await native.pickVault();
      if ('cancelled' in picked) return false;
      await restart();
      return true;
    },
    create: async (name) => {
      await native.createVault({ name });
      await restart();
    },
    forget: (id) => native.forgetVault({ id }),
  };
  return {
    kind: 'mobile',
    os,
    vaultName: info.vaultName,
    // Vault switching is implemented natively on Android only so far.
    ...(os === 'android' ? { vaults } : {}),
    fs: capacitorFs(native),
    storage: await opfsStorage(`vault-${storageKey}`),
    lifecycle: {
      onPause: (l) => (pause.add(l), () => pause.delete(l)),
      onResume: (l) => (resume.add(l), () => resume.delete(l)),
    },
    shell: {
      openExternal: async (url) => {
        window.open(url, '_system');
      },
      revealInFileManager: (path: VaultPath) => native.share({ path }),
    },
  };
}
