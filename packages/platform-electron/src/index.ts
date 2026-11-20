import type { ChatGptHost, ChildProcessHandle, Platform, ProcessHost } from '@pumice/platform';
import type { ChatGptMessage, ProcEvent, PumiceHost } from './host';

export type { PumiceHost } from './host';

declare global {
  interface Window {
    pumiceHost?: PumiceHost;
  }
}

/** Renderer-side Platform backed by the preload bridge. */
export async function createElectronPlatform(host: PumiceHost): Promise<Platform> {
  const info = await host.info();
  const pause = new Set<() => void>();
  const resume = new Set<() => void>();
  window.addEventListener('blur', () => pause.forEach((l) => l()));
  window.addEventListener('focus', () => resume.forEach((l) => l()));
  host.onBeforeClose(async () => {
    for (const l of pause) l();
    // Give flushes (debounced document saves) a moment to reach the disk.
    await new Promise((r) => setTimeout(r, 150));
  });
  return {
    kind: 'desktop',
    os: info.os,
    vaultName: info.vaultName,
    vaultRoot: info.vaultPath,
    fs: {
      list: () => host.fs.list(),
      stat: (p) => host.fs.stat(p),
      readText: (p) => host.fs.readText(p),
      readBinary: (p) => host.fs.readBinary(p),
      write: (p, d) => host.fs.write(p, d),
      rename: (a, b) => host.fs.rename(a, b),
      remove: (p, opts) => host.fs.remove(p, opts?.trash ?? true),
      mkdir: (p) => host.fs.mkdir(p),
    },
    watcher: { watch: (listener) => host.onWatch(listener) },
    storage: host.storage,
    lifecycle: {
      onPause: (l) => (pause.add(l), () => pause.delete(l)),
      onResume: (l) => (resume.add(l), () => resume.delete(l)),
    },
    shell: {
      openExternal: (url) => host.openExternal(url),
      revealInFileManager: (p) => host.revealInFileManager(p),
    },
    net: { fetchText: (url) => host.fetchText(url) },
    vaults: {
      list: () => host.vaults.list(),
      open: (id, opts) => host.vaults.open(id, !!opts?.newWindow),
      pick: (opts) => host.vaults.pick(!!opts?.newWindow),
      forget: (id) => host.vaults.forget(id),
      manage: () => host.vaults.manage(),
    },
    chatgpt: chatGptHost(host),
    process: processHost(host),
    frames: {
      open: async ({ folder, files, inject, network }) => {
        const token = await host.frames.open(folder, files, inject, network);
        return {
          url: (path) =>
            `app://frame.${token}/${path.split('/').map(encodeURIComponent).join('/')}`,
          dispose: () => void host.frames.close(token),
        };
      },
    },
  };
}

/** Errors cross IPC as plain messages; this marker carries "sign in again". */
const SIGN_IN = '[sign-in] ';
const signInError = (e: unknown): Error => {
  const message = e instanceof Error ? e.message : String(e);
  const i = message.indexOf(SIGN_IN);
  if (i < 0) return e instanceof Error ? e : new Error(message);
  return Object.assign(new Error(message.slice(i + SIGN_IN.length)), { needsSignIn: true });
};

function chatGptHost(host: PumiceHost): ChatGptHost {
  let nextId = 1;
  const streams = new Map<number, (m: ChatGptMessage) => void>();
  host.chatgpt.onEvent((m) => streams.get(m.id)?.(m));
  const call = <T>(p: Promise<T>) => p.catch((e) => Promise.reject(signInError(e)));
  return {
    status: () => host.chatgpt.status(),
    login: () => call(host.chatgpt.login()),
    logout: () => host.chatgpt.logout(),
    models: () => call(host.chatgpt.models()),
    responses: (body, onEvent, signal) =>
      new Promise<void>((resolve, reject) => {
        const id = nextId++;
        const finish = (error?: Error) => {
          streams.delete(id);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => {
          void host.chatgpt.abort(id);
          finish(new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort);
        streams.set(id, (m) => {
          if ('event' in m) onEvent(m.event);
          else if (m.error)
            finish(Object.assign(new Error(m.error), { needsSignIn: !!m.needsSignIn }));
          else finish();
        });
        host.chatgpt.start(id, body).catch((e) => finish(signInError(e)));
      }),
  };
}

/** Child processes over IPC, exposed as web streams. */
function processHost(host: PumiceHost): ProcessHost {
  const listeners = new Map<number, (e: ProcEvent) => void>();
  // Events can arrive before `spawn` resolves with the id; keep them until then.
  const early = new Map<number, ProcEvent[]>();
  host.proc.onEvent((e) => {
    const l = listeners.get(e.id);
    if (l) l(e);
    else early.set(e.id, [...(early.get(e.id) ?? []), e]);
  });
  return {
    which: (command) => host.proc.which(command),
    async spawn(command, args, opts): Promise<ChildProcessHandle> {
      const id = await host.proc.spawn(command, args, opts?.env);
      let out!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
      const stderr = new Set<(text: string) => void>();
      let resolveExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const handle = (e: ProcEvent) => {
        if (e.kind === 'stdout') out.enqueue(e.data);
        else if (e.kind === 'stderr') stderr.forEach((l) => l(e.data));
        else {
          listeners.delete(id);
          try {
            out.close();
          } catch {
            // already closed
          }
          resolveExit(e.code);
        }
      };
      listeners.set(id, handle);
      for (const e of early.get(id) ?? []) handle(e);
      early.delete(id);
      const stdin = new WritableStream<Uint8Array>({
        write: (chunk) => host.proc.write(id, chunk),
        close: () => host.proc.closeStdin(id),
      });
      return {
        stdin,
        stdout,
        onStderr: (l) => (stderr.add(l), () => stderr.delete(l)),
        exited,
        kill: () => void host.proc.kill(id),
      };
    },
  };
}
