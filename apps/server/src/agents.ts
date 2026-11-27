/**
 * Agent programs of a served folder (Claude Code, Codex, ...): run by the server in the folder,
 * for the chats it keeps (sessions.ts), as the desktop app runs them on its computer.
 *
 * Only the programs the app knows as assistants (or ones named with PUMICE_AGENTS) are started,
 * and only for someone who opened the folder with its key: that key is then as good as a login
 * to this machine, as the user running the server.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { DEFAULT_AGENTS, type AgentConfig } from '@pumice/core-agents/session';
import type { ChildProcessHandle, ProcessHost } from '@pumice/platform';

const line = (command: string, args: string[]) =>
  [command, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');

/** The command lines that may be started: the app's assistants, and any named on start. */
export function allowedAgents(extra = process.env.PUMICE_AGENTS ?? ''): Set<string> {
  const lines = DEFAULT_AGENTS.filter((a) => a.kind !== 'chatgpt').map((a) =>
    line(a.command, a.args),
  );
  for (const l of extra.split(';')) if (l.trim()) lines.push(l.trim());
  return new Set(lines);
}

/** The allowed agents by name (the app's), or by command line (the others). */
export function agentNames(allowed: Set<string>): string {
  const named = new Map(
    DEFAULT_AGENTS.filter((a) => a.kind !== 'chatgpt').map((a) => [
      line(a.command, a.args),
      a.name,
    ]),
  );
  return [...allowed].map((l) => named.get(l) ?? l).join(', ');
}

/** PATH of the user's login shell (a server started by a service manager has a short one). */
let shellPath: Promise<string> | undefined;
function loginShellPath(): Promise<string> {
  shellPath ??= new Promise((resolve) => {
    if (process.platform === 'win32') return resolve(process.env.PATH ?? '');
    const shell = process.env.SHELL || '/bin/sh';
    execFile(shell, ['-ilc', 'printf "%s" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.trim() ? stdout.trim().split('\n').pop()! : (process.env.PATH ?? ''));
    });
  });
  return shellPath;
}

export async function which(command: string): Promise<string | null> {
  if (isAbsolute(command))
    return fs.access(command).then(
      () => command,
      () => null,
    );
  for (const dir of (await loginShellPath()).split(delimiter)) {
    const full = join(dir, command);
    if (
      await fs.access(full).then(
        () => true,
        () => false,
      )
    )
      return full;
  }
  return null;
}

/** The agents that may run, as the app knows agents: its own, and the command lines named. */
export function agentConfigs(allowed: Set<string>): AgentConfig[] {
  const known = DEFAULT_AGENTS.filter(
    (a) => a.kind !== 'chatgpt' && allowed.has(line(a.command, a.args)),
  );
  const theirs = new Set(known.map((a) => line(a.command, a.args)));
  const others = [...allowed]
    .filter((l) => !theirs.has(l))
    .map((l): AgentConfig => {
      const [command, ...args] = splitLine(l);
      return {
        id: `cmd-${createHash('sha256').update(l).digest('hex').slice(0, 8)}`,
        name: l,
        command: command ?? '',
        args,
      };
    });
  return [...known, ...others];
}

/** Words of a command line (double quotes group, as `line` writes them). */
function splitLine(l: string): string[] {
  const out: string[] = [];
  for (const m of l.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g))
    out.push(m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : m[2]!);
  return out;
}

/**
 * Programs started in `root`, each in a process group of its own: ending it ends what it
 * started too (npx starts the agent, the agent its tools), unless that was made to outlive it.
 */
export function folderProcesses(
  root: string,
  allowed: Set<string>,
): ProcessHost & {
  /** Ends every program still running. */
  stopAll(): void;
} {
  const running = new Set<() => void>();
  return {
    which,
    async spawn(command, args, opts): Promise<ChildProcessHandle> {
      if (!allowed.has(line(command, args)))
        throw new Error(`Not allowed to run this program here: ${line(command, args)}`);
      const PATH = await loginShellPath();
      const resolved = (await which(command)) ?? command;
      const child = spawn(resolved, args, {
        cwd: root,
        env: { ...process.env, PATH, ...opts?.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      // (Input after the program stopped reading: lost, and no reason to stop the server.)
      child.stdin.on('error', () => undefined);
      const stderr = new Set<(text: string) => void>();
      child.stderr.on('data', (d: Buffer) => stderr.forEach((l) => l(d.toString('utf8'))));
      /** Ends the program and everything it started: asked first, then made to. */
      const stop = () => {
        const signal = (s: NodeJS.Signals) => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, s);
            else child.kill(s);
          } catch {
            // (Gone already.)
          }
        };
        signal('SIGTERM');
        setTimeout(() => signal('SIGKILL'), 3000).unref();
      };
      running.add(stop);
      const exited = new Promise<number | null>((resolve) => {
        child.on('error', (e) => {
          stderr.forEach((l) => l(`${e.message}\n`));
          resolve(-1);
        });
        child.on('exit', (code) => resolve(code));
      }).finally(() => running.delete(stop));
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return {
        stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        onStderr: (l) => (stderr.add(l), () => stderr.delete(l)),
        exited,
        kill: stop,
      };
    },
    stopAll() {
      for (const stop of [...running]) stop();
    },
  };
}
