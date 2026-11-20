import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ChildProcessHandle, ProcessHost } from '@pumice/api';
import { describe, expect, it } from 'vitest';
import { AgentSession, type TranscriptItem } from '../src/session';

const MOCK = fileURLToPath(new URL('./fixtures/mock-agent.mjs', import.meta.url));

/** Spawns real processes (here: the mock agent under Node). */
const nodeHost: ProcessHost = {
  which: async () => null,
  async spawn(command, args): Promise<ChildProcessHandle> {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', () => undefined);
    const listeners = new Set<(t: string) => void>();
    child.stderr.on('data', (d: Buffer) => listeners.forEach((l) => l(d.toString())));
    return {
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      onStderr: (l) => (listeners.add(l), () => listeners.delete(l)),
      exited: new Promise((r) => {
        child.on('exit', (code) => r(code));
        child.on('error', () => r(-1));
      }),
      kill: () => child.kill(),
    };
  },
};

function setup() {
  const files: Record<string, string> = { 'note.md': 'Hello' };
  const session = new AgentSession(
    { id: 'mock', name: 'Mock', command: process.execPath, args: [MOCK] },
    nodeHost,
    {
      root: '/vault',
      read: async (p) => {
        if (!(p in files)) throw new Error(`missing ${p}`);
        return files[p]!;
      },
      write: async (p, c) => void (files[p] = c),
    },
  );
  return { session, files };
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const answerPermissions = (session: AgentSession, optionId: string) =>
  session.onDidChange(() => {
    for (const item of session.items) {
      if (item.kind === 'permission' && !item.chosen) item.respond?.(optionId);
    }
  });

describe('agent session (ACP)', () => {
  it('runs a turn: streams text, plans, tool calls, permission, edits through the client', async () => {
    const { session, files } = setup();
    await session.start();
    expect(session.status).toBe('ready');
    expect(session.modes.map((m) => m.id)).toEqual(['default', 'plan']);
    const sub = answerPermissions(session, 'allow');
    await session.prompt('fix it', [
      {
        type: 'resource',
        resource: { uri: 'file:///vault/note.md', text: 'Hello', mimeType: 'text/markdown' },
      },
    ]);
    sub.dispose();
    expect(session.status).toBe('ready');
    expect(files['note.md']).toBe('Hello (edited by agent)');
    const kinds = session.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'thought', 'plan', 'agent', 'tool', 'permission', 'agent']);
    const agentTexts = session.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : []));
    // The read outside the vault was refused (no " LEAK").
    expect(agentTexts).toEqual(['Got "fix it" with 1 resource(s).', ' (outside read refused)']);
    const tool = session.items.find((i) => i.kind === 'tool') as Extract<
      TranscriptItem,
      { kind: 'tool' }
    >;
    expect(tool.status).toBe('completed');
    expect(tool.content[0]).toMatchObject({ type: 'diff', newText: 'Hello (edited by agent)' });
    expect(tool.locations).toEqual(['/vault/note.md']);
    session.dispose();
  });

  it('rejected permission leaves the note alone', async () => {
    const { session, files } = setup();
    await session.start();
    const sub = answerPermissions(session, 'reject');
    await session.prompt('fix it');
    sub.dispose();
    expect(files['note.md']).toBe('Hello');
    const tool = session.items.find((i) => i.kind === 'tool') as Extract<
      TranscriptItem,
      { kind: 'tool' }
    >;
    expect(tool.status).toBe('failed');
    session.dispose();
  });

  it('reports a command that is not installed', async () => {
    const session = new AgentSession(
      {
        id: 'x',
        name: 'X',
        command: '/nonexistent/agent-binary',
        args: [],
        setupHint: 'Install X.',
      },
      nodeHost,
      { root: '/vault', read: async () => '', write: async () => {} },
    );
    await session.start();
    await waitFor(() => session.status === 'closed' || session.status === 'error');
    expect(session.items.some((i) => i.kind === 'error')).toBe(true);
    session.dispose();
  });
});
