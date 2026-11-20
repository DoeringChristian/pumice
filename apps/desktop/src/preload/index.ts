import type { FsWatchEvent } from '@pumice/platform';
import {
  IPC,
  type ChatGptMessage,
  type LauncherHost,
  type ProcEvent,
  type PumiceHost,
} from '@pumice/platform-electron/host';
import { contextBridge, ipcRenderer } from 'electron';

const invoke = <T>(op: string, ...args: unknown[]) =>
  ipcRenderer.invoke(IPC.invoke, op, ...args) as Promise<T>;

const host: PumiceHost = {
  info: () => invoke('info'),
  fs: {
    list: () => invoke('fs.list'),
    stat: (p) => invoke('fs.stat', p),
    readText: (p) => invoke('fs.readText', p),
    readBinary: (p) => invoke('fs.readBinary', p),
    write: (p, d) => invoke('fs.write', p, d),
    rename: (a, b) => invoke('fs.rename', a, b),
    remove: (p, trash) => invoke('fs.remove', p, trash),
    mkdir: (p) => invoke('fs.mkdir', p),
  },
  storage: {
    get: (k) => invoke('storage.get', k),
    set: (k, v) => invoke('storage.set', k, v),
    delete: (k) => invoke('storage.delete', k),
  },
  onWatch(listener) {
    const handler = (_: unknown, events: FsWatchEvent[]) => listener(events);
    ipcRenderer.on(IPC.watch, handler);
    return () => ipcRenderer.off(IPC.watch, handler);
  },
  onBeforeClose(listener) {
    const handler = () => {
      void listener().finally(() => ipcRenderer.send(IPC.closeReady));
    };
    ipcRenderer.on(IPC.beforeClose, handler);
    return () => ipcRenderer.off(IPC.beforeClose, handler);
  },
  openExternal: (url) => invoke('shell.openExternal', url),
  revealInFileManager: (p) => invoke('shell.reveal', p),
  vaults: {
    list: () => invoke('vaults.list'),
    open: (path, newWindow) => invoke('vaults.open', path, newWindow),
    pick: (newWindow) => invoke('vaults.pick', newWindow),
    forget: (path) => invoke('vaults.forget', path),
    manage: () => invoke('vaults.manage'),
  },
  frames: {
    open: (folder, files, inject, network) => invoke('frames.open', folder, files, inject, network),
    close: (token) => invoke('frames.close', token),
  },
  fetchText: (url) => invoke('net.fetchText', url),
  closeWindow: () => invoke('window.close'),
  chatgpt: {
    status: () => invoke('chatgpt.status'),
    login: () => invoke('chatgpt.login'),
    logout: () => invoke('chatgpt.logout'),
    models: () => invoke('chatgpt.models'),
    start: (id, body) => invoke('chatgpt.start', id, body),
    abort: (id) => invoke('chatgpt.abort', id),
    onEvent(listener) {
      const handler = (_: unknown, m: ChatGptMessage) => listener(m);
      ipcRenderer.on(IPC.chatgpt, handler);
      return () => ipcRenderer.off(IPC.chatgpt, handler);
    },
  },
  proc: {
    spawn: (command, args, env) => invoke('proc.spawn', command, args, env),
    write: (id, data) => invoke('proc.write', id, data),
    closeStdin: (id) => invoke('proc.closeStdin', id),
    kill: (id) => invoke('proc.kill', id),
    which: (command) => invoke('proc.which', command),
    onEvent(listener) {
      const handler = (_: unknown, e: ProcEvent) => listener(e);
      ipcRenderer.on(IPC.proc, handler);
      return () => ipcRenderer.off(IPC.proc, handler);
    },
  },
};

const launch = <T>(op: string, ...args: unknown[]) =>
  ipcRenderer.invoke(IPC.launcher, op, ...args) as Promise<T>;

/** The vault selector window's API; the main process only answers that window. */
const launcher: LauncherHost = {
  platform: process.platform,
  info: () => launch('info'),
  list: () => launch('list'),
  open: (path) => launch('open', path),
  pick: () => launch('pick'),
  chooseFolder: () => launch('chooseFolder'),
  create: (name, parent) => launch('create', name, parent),
  forget: (path) => launch('forget', path),
  reveal: (path) => launch('reveal', path),
};

contextBridge.exposeInMainWorld('pumiceHost', host);
contextBridge.exposeInMainWorld('pumiceLauncher', launcher);
