import { app, dialog, type BrowserWindow } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { IPC, type ProcEvent } from '@pumice/platform-electron/host';

/**
 * Agent processes (docs/plan/09). The renderer can only start a command after the user allowed
 * it in a native dialog (remembered per vault in the app's data folder), so a compromised page or
 * plugin can't run programs silently. Processes run in the vault folder and die with the window.
 */

const approvalsPath = () => join(app.getPath('userData'), 'allowed-commands.json');

type Approvals = Record<string, string[]>; // vault root → allowed command lines

async function readApprovals(): Promise<Approvals> {
  try {
    return JSON.parse(await fs.readFile(approvalsPath(), 'utf8')) as Approvals;
  } catch {
    return {};
  }
}

const commandLine = (command: string, args: string[]) =>
  [command, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');

/** PATH of the user's login shell: apps started from Finder/Dock get a minimal PATH. */
let shellPath: Promise<string> | undefined;
function loginShellPath(): Promise<string> {
  shellPath ??= new Promise((resolve) => {
    if (process.platform === 'win32') return resolve(process.env.PATH ?? '');
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "%s" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      const fallback = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(
        delimiter,
      );
      resolve(!err && stdout.trim() ? stdout.trim().split('\n').pop()! : fallback);
    });
  });
  return shellPath;
}

async function which(command: string): Promise<string | null> {
  if (isAbsolute(command)) {
    try {
      await fs.access(command);
      return command;
    } catch {
      return null;
    }
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (await loginShellPath()).split(delimiter)) {
    for (const ext of exts) {
      const full = join(dir, command + ext);
      try {
        await fs.access(full);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export class ProcessManager {
  private next = 1;
  private readonly procs = new Map<number, ChildProcess>();

  constructor(
    private readonly root: string,
    private readonly window: BrowserWindow,
  ) {}

  private send(e: ProcEvent) {
    if (!this.window.isDestroyed()) this.window.webContents.send(IPC.proc, e);
  }

  private async approve(command: string, args: string[]): Promise<void> {
    const line = commandLine(command, args);
    const approvals = await readApprovals();
    if (approvals[this.root]?.includes(line)) return;
    const { response, checkboxChecked } = await dialog.showMessageBox(this.window, {
      type: 'question',
      buttons: ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Allow Pumice to run this program?',
      detail: `${line}\n\nIt runs in the vault folder ${this.root} with your user's permissions. Only allow programs you trust (for example an agent you installed).`,
      checkboxLabel: 'Always allow for this vault',
      checkboxChecked: true,
    });
    if (response !== 0) throw new Error('Not allowed to run this program.');
    if (checkboxChecked) {
      approvals[this.root] = [...(approvals[this.root] ?? []), line];
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(approvalsPath(), JSON.stringify(approvals, null, 2));
    }
  }

  async spawn(command: unknown, args: unknown, env: unknown): Promise<number> {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Invalid command');
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))
      throw new Error('Invalid arguments');
    const extraEnv: Record<string, string> = {};
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string') extraEnv[k] = v;
    }
    await this.approve(command, args as string[]);
    const PATH = await loginShellPath();
    const resolved = (await which(command)) ?? command;
    const child = spawn(resolved, args as string[], {
      cwd: this.root,
      env: { ...process.env, PATH, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      // .cmd shims on Windows need a shell.
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved),
    });
    const id = this.next++;
    this.procs.set(id, child);
    child.stdout!.on('data', (d: Buffer) =>
      this.send({ id, kind: 'stdout', data: new Uint8Array(d) }),
    );
    child.stderr!.on('data', (d: Buffer) =>
      this.send({ id, kind: 'stderr', data: d.toString('utf8') }),
    );
    child.on('error', (err) => {
      this.send({ id, kind: 'stderr', data: `${err.message}\n` });
      this.send({ id, kind: 'exit', code: -1 });
      this.procs.delete(id);
    });
    child.on('exit', (code) => {
      this.send({ id, kind: 'exit', code });
      this.procs.delete(id);
    });
    return id;
  }

  private get(id: unknown): ChildProcess {
    const p = typeof id === 'number' ? this.procs.get(id) : undefined;
    if (!p) throw new Error('No such process');
    return p;
  }

  write(id: unknown, data: unknown): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new Error('Invalid data');
    const p = this.get(id);
    return new Promise((resolve, reject) =>
      p.stdin!.write(data, (err) => (err ? reject(err) : resolve())),
    );
  }

  closeStdin(id: unknown): void {
    this.get(id).stdin!.end();
  }

  kill(id: unknown): void {
    if (typeof id === 'number') this.procs.get(id)?.kill();
  }

  which(command: unknown): Promise<string | null> {
    if (typeof command !== 'string') throw new Error('Invalid command');
    return which(command);
  }

  dispose(): void {
    for (const p of this.procs.values()) p.kill();
    this.procs.clear();
  }
}
