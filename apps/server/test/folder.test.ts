import type { PublicUser, VaultInfo } from '@pumice/collab-protocol';
import { CollabClient } from '@pumice/core-collab/client';
import { SharedVault } from '@pumice/core-collab/shared-vault';
import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { VaultImpl } from '@pumice/core-vault';
import { createMemoryPlatform } from '@pumice/platform-memory';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { realpathSync } from 'node:fs';
import { agentConfigs, allowedAgents, folderProcesses } from '../src/agents.ts';
import { serveFolder, type ServedFolder } from '../src/folder.ts';
import { AgentChats } from '../src/sessions.ts';
import { startServer, type RunningServer } from '../src/server.ts';

/** The test agent (an ACP agent that reads note.md, asks, and edits it). */
const MOCK_AGENT = `node ${fileURLToPath(new URL('../../../plugins/core-agents/test/fixtures/mock-agent.mjs', import.meta.url))}`;
/** One that uses Pumice's note tools (note-tools.ts). */
const MOCK_MCP = `node ${fileURLToPath(new URL('../../../plugins/core-agents/test/fixtures/mock-mcp-agent.mjs', import.meta.url))}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** A server serving a new folder with these files. */
/** `spawnDelay`: agent programs take this long to start (ms). */
async function served(files: Record<string, string>, opts: { spawnDelay?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pumice-folder-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const dataDir = join(root, '.pumice-server');
  const start = async () => {
    const server = await startServer({
      dataDir,
      open: true,
      devLogin: true,
      sendLoginCode: () => undefined,
    });
    const folder = await serveFolder({
      root,
      dataDir,
      store: server.store,
      url: server.url,
    });
    // Its agents: the test agent (and the app's, which these tests do not start).
    const allowed = allowedAgents(`${MOCK_AGENT};${MOCK_MCP}`);
    const configs = agentConfigs(allowed);
    const processes = folderProcesses(folder.root, allowed);
    if (opts.spawnDelay) {
      const spawn = processes.spawn.bind(processes);
      processes.spawn = async (...a) => {
        await sleep(opts.spawnDelay!);
        return spawn(...a);
      };
    }
    const chats = new AgentChats({
      root: folder.root,
      fs: folder.fs,
      vault: folder.vault,
      documents: folder.documents,
      index: folder.index,
      agents: configs,
      processes,
    });
    server.addOpenVault({
      vaultId: folder.vaultId,
      name: folder.name,
      key: folder.key,
      root: folder.root,
      chats,
      agents: configs.map((c) => c.name),
    });
    const mock = configs.find((c) => c.name === MOCK_AGENT)!.id;
    const mockTools = configs.find((c) => c.name === MOCK_MCP)!.id;
    return { server, folder, chats, processes, mock, mockTools };
  };
  let running:
    | {
        server: RunningServer;
        folder: ServedFolder;
        chats: AgentChats;
        processes: ReturnType<typeof folderProcesses>;
        mock: string;
        mockTools: string;
      }
    | undefined = await start();
  const stop = async () => {
    if (!running) return;
    await running.chats.close();
    running.processes.stopAll();
    await running.folder.close();
    await running.server.close();
    running = undefined;
  };
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(stop);
  return {
    root,
    get server() {
      return running!.server;
    },
    get folder() {
      return running!.folder;
    },
    /** The test agent's id. */
    get mock() {
      return running!.mock;
    },
    /** The id of the test agent that uses Pumice's note tools. */
    get mockTools() {
      return running!.mockTools;
    },
    disk: (path: string) =>
      existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined,
    write: (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    stop,
    restart: async () => {
      await stop();
      running = await start();
    },
  };
}

/** Opens a vault with a link's key, as a browser does (signed in already: `token`). */
async function openWithKey(server: RunningServer, vault: string, key: string, token?: string) {
  return fetch(`${server.url}/api/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ vault, key }),
  });
}

/** A device that opens the served folder's vault with its edit link. */
async function joiner(s: { server: RunningServer; folder: ServedFolder }, key?: string) {
  const { server } = s;
  const r = await openWithKey(server, s.folder.vaultId, key ?? s.folder.key);
  expect(r.status).toBe(200);
  const {
    token,
    user,
    vault: info,
  } = (await r.json()) as {
    token: string;
    user: PublicUser;
    vault: VaultInfo;
  };
  const client = new CollabClient(server.url, token);
  const platform = createMemoryPlatform({ files: {} });
  const vault = new VaultImpl(platform);
  await vault.load();
  const documents = new DocumentsImpl(vault, { saveDelay: 0 });
  documents.registerCodec(markdownCodec);
  const map = new Map<string, string>();
  const shared = new SharedVault({
    client,
    vaultId: info.id,
    user,
    role: info.role,
    vault,
    documents,
    storage: {
      get: async (k) => map.get(k),
      set: async (k, v) => void map.set(k, v),
      delete: async (k) => void map.delete(k),
    },
  });
  documents.registerProvider(shared.provider());
  client.connect();
  await waitFor(() => client.state === 'online', 'connection');
  await shared.start();
  cleanup.push(() => {
    shared.dispose();
    client.dispose();
  });
  return { vault, info, read: (p: string) => platform.fs.snapshot()[p] };
}

describe('serving a folder', { timeout: 30000 }, () => {
  it('shares the folder, and edits go both ways', async () => {
    const s = await served({
      'Report.md': '# Report\n\nFirst line.\n',
      'Notes/Other.md': 'other\n',
    });
    const b = await joiner(s);
    expect(b.info.role).toBe('owner');
    await waitFor(
      () => b.read('Report.md') === '# Report\n\nFirst line.\n',
      'the folder on the device',
    );
    await waitFor(() => b.read('Notes/Other.md') === 'other\n', 'a note in a subfolder');

    // Written into the folder (an agent's report): reaches the device.
    s.write('Report.md', '# Report\n\nFirst line.\nSecond line.\n');
    s.write('New.md', 'new\n');
    await waitFor(() => b.read('Report.md')?.includes('Second line.') === true, 'an edit on disk');
    await waitFor(() => b.read('New.md') === 'new\n', 'a new file on disk');

    // Edited on the device: written into the folder.
    await b.vault.write('Notes/Other.md', 'other, edited\n');
    await waitFor(() => s.disk('Notes/Other.md') === 'other, edited\n', 'an edit on the device');

    // Deleted on the device: goes into the folder's .trash.
    await b.vault.delete('New.md');
    await waitFor(() => s.disk('New.md') === undefined, 'a deletion on the device');
    expect(s.disk('.trash/New.md')).toBe('new\n');
  });

  it('catches up with what changed in the folder while it was down', async () => {
    const s = await served({ 'Report.md': 'one\n' });
    const key = s.folder.key;
    const vaultId = s.folder.vaultId;
    await s.stop();
    s.write('Report.md', 'one\ntwo\n');
    s.write('Later.md', 'later\n');
    await s.restart();
    // The same vault (not a new one), and its key still opens it.
    expect(s.folder.vaultId).toBe(vaultId);
    const b = await joiner(s, key);
    await waitFor(() => b.read('Report.md') === 'one\ntwo\n', 'an edit made while down');
    await waitFor(() => b.read('Later.md') === 'later\n', 'a file added while down');
  });

  it('takes in files added while down to a vault that was empty', async () => {
    const s = await served({});
    const key = s.folder.key;
    await s.stop();
    s.write('First.md', 'first\n');
    await s.restart();
    const b = await joiner(s, key);
    await waitFor(() => b.read('First.md') === 'first\n', 'a file added to the empty vault');
  });

  it('keeps its sign-in private and follows no links out of the folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pumice-outside-'));
    cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.md'), 'secret\n');
    const s = await served({ 'Note.md': 'note\n' });
    expect(statSync(join(s.root, '.pumice-server', 'folder.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.root, '.pumice-server')).mode & 0o777).toBe(0o700);

    symlinkSync(outside, join(s.root, 'link'));
    symlinkSync(join(outside, 'secret.md'), join(s.root, 'secret.md'));
    s.write('Note.md', 'note, edited\n');
    const b = await joiner(s);
    await waitFor(() => b.read('Note.md') === 'note, edited\n', 'the folder on the device');
    await b.vault.create('link/new.md', 'through the link\n');
    await b.vault.write('secret.md', 'overwritten\n');
    await sleep(800);
    expect(b.read('link/secret.md')).toBeUndefined();
    expect(existsSync(join(outside, 'new.md'))).toBe(false);
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('secret\n');
  });

  it('opens with its link only, each opening under a name of its own; no sign-in', async () => {
    const s = await served({ 'Note.md': 'note\n' });
    const id = s.folder.vaultId;
    expect((await openWithKey(s.server, id, 'wrong')).status).toBe(403);
    expect((await openWithKey(s.server, id, '')).status).toBe(403);
    expect((await openWithKey(s.server, 'other', s.folder.key)).status).toBe(403);
    type Opened = { user: PublicUser; token: string; vault: VaultInfo };
    const one = (await (await openWithKey(s.server, id, s.folder.key)).json()) as Opened;
    const two = (await (await openWithKey(s.server, id, s.folder.key)).json()) as Opened;
    expect(one.user.id).not.toBe(two.user.id);
    expect(one.user.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(one.vault.role).toBe('owner');
    // Opened before (signed in): the same name.
    const again = (await (
      await openWithKey(s.server, id, s.folder.key, one.token)
    ).json()) as Opened;
    expect(again.user.id).toBe(one.user.id);
    expect(again.token).toBe(one.token);
    const info = await (await fetch(`${s.server.url}/api/info`)).json();
    expect(info).toEqual({ pumice: true, open: true });
    const code = await fetch(`${s.server.url}/api/auth/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com' }),
    });
    expect(code.status).toBe(403);
    // The link stays the same across restarts.
    const key = s.folder.key;
    await s.restart();
    expect(s.folder.key).toBe(key);
  });

  it('keeps a chat going with no window open; another window answers its question', async () => {
    const s = await served({ 'note.md': 'Hello' });
    const id = s.folder.vaultId;
    const token = (
      (await (await openWithKey(s.server, id, s.folder.key)).json()) as {
        token: string;
      }
    ).token;
    const one = await agentsSocket(s.server, id, token);
    const hello = await one.next((m) => m.t === 'hello');
    expect(hello.root).toBe(realpathSync(s.root));
    expect(hello.agents.map((a: { id: string }) => a.id)).toContain(s.mock);
    one.send({ t: 'new', id: 'chat-1', agent: s.mock });
    one.send({ t: 'prompt', id: 'chat-1', req: 1, text: 'go' });
    // It asks; the window that asked goes away.
    await one.next((m) => m.t === 'chats' && m.chats.some((c: { waiting: boolean }) => c.waiting));
    one.close();

    const two = await agentsSocket(s.server, id, token);
    const list = await two.next((m) => m.t === 'chats');
    expect(list.chats).toMatchObject([{ id: 'chat-1', open: true, waiting: true }]);
    two.send({ t: 'follow', id: 'chat-1' });
    const chat = await two.next((m) => m.t === 'chat' && m.id === 'chat-1');
    const question = chat.items.find((i: { kind: string }) => i.kind === 'permission');
    expect(question.chosen).toBeUndefined();
    two.send({ t: 'answer', id: 'chat-1', item: question.id, option: 'allow' });
    // The agent edits the note on the server, through the vault: the folder has it.
    await waitFor(() => s.disk('note.md') === 'Hello (edited by agent)', 'the agent’s edit');
    await two.next(
      (m) =>
        m.t === 'update' &&
        m.items.some((i: { kind: string; text?: string }) =>
          i.text?.includes('outside read refused'),
        ),
    );
    // Saved in the folder, with who started it.
    await waitFor(() => !!s.disk('.pumice/chats/chat-1.json'), 'the chat’s file');
    await waitFor(
      () => JSON.parse(s.disk('.pumice/chats/chat-1.json')!).items.length > 3,
      'the whole chat in its file',
    );
    const saved = JSON.parse(s.disk('.pumice/chats/chat-1.json')!);
    expect(saved.by.id).toBe(hello.user.id);
    expect(saved.items[0]).toMatchObject({ kind: 'user', text: 'go', by: hello.user.name });

    // After a restart of the server it is open still; its next prompt starts its agent again,
    // which answers its own questions now.
    await s.restart();
    const three = await agentsSocket(s.server, s.folder.vaultId, token);
    const again = await three.next((m) => m.t === 'chats');
    expect(again.chats).toMatchObject([{ id: 'chat-1', open: true, status: 'ready' }]);
    three.send({ t: 'follow', id: 'chat-1' });
    const kept = await three.next((m) => m.t === 'chat');
    expect(kept.items.length).toBe(saved.items.length);
    three.send({ t: 'auto', id: 'chat-1', on: true });
    // Two prompts at once: one agent starts, and takes them in turn.
    three.send({ t: 'prompt', id: 'chat-1', req: 2, text: 'again' });
    three.send({ t: 'prompt', id: 'chat-1', req: 3, text: 'once more' });
    await three.next((m) => m.t === 'done' && m.req === 2);
    expect(agentsIn(s.root)).toBe(1);
    await three.next((m) => m.t === 'done' && m.req === 3);
    // (The agent asked again: the chat answered itself, with no one there to.)
    await waitFor(
      () => s.disk('note.md') === 'Hello (edited by agent) (edited by agent) (edited by agent)',
      'the second edit',
    );

    // The model and the effort, from any window.
    three.send({ t: 'model', id: 'chat-1', model: 'deep' });
    three.send({ t: 'effort', id: 'chat-1', effort: 'high' });
    await three.next(
      (m) =>
        m.t === 'update' && m.state?.currentModel === 'deep' && m.state?.currentEffort === 'high',
    );

    // Ending it ends its agent; the chat stays among the earlier ones.
    // (Its agent: the test agent running in this folder; other tests run it elsewhere.)
    const agentRuns = () => agentsIn(s.root) > 0;
    expect(agentRuns()).toBe(true);
    three.send({ t: 'end', id: 'chat-1' });
    await three.next((m) => m.t === 'chats' && m.chats.some((c: { open: boolean }) => !c.open));
    await waitFor(() => !agentRuns(), 'the agent to end');
    three.close();
  });

  it('gives server chats the note tools and the window’s guidance', async () => {
    const s = await served({ 'note.md': 'Hello' });
    const id = s.folder.vaultId;
    const token = (
      (await (await openWithKey(s.server, id, s.folder.key)).json()) as {
        token: string;
      }
    ).token;
    const win = await agentsSocket(s.server, id, token);
    await win.next((m) => m.t === 'hello');
    win.send({ t: 'new', id: 'tools-1', agent: s.mockTools, guidance: 'Frames: GUIDANCE-MARK' });
    win.send({ t: 'prompt', id: 'tools-1', req: 1, text: 'go' });
    await win.next((m) => m.t === 'done' && m.req === 1);
    // Through the vault's document on the server, into the folder.
    await waitFor(() => s.disk('note.md') === 'Hello, tools', 'the edit through the tools');
    await waitFor(() => !!s.disk('.pumice/chats/tools-1.json'), 'the chat’s file');
    await waitFor(
      () =>
        JSON.parse(s.disk('.pumice/chats/tools-1.json')!).items.some(
          (i: { kind: string }) => i.kind === 'agent',
        ),
      'the answer in the chat’s file',
    );
    const answer = JSON.parse(s.disk('.pumice/chats/tools-1.json')!).items.find(
      (i: { kind: string }) => i.kind === 'agent',
    );
    const said = JSON.parse(answer.text);
    // Search (the folder's index on the server) found the note as it was then.
    expect(said.searched).toContain('note.md');
    expect(said.drew).toBe(true);
    expect(s.disk('sketch.excalidraw')).toContain('"type": "rectangle"');
    expect(said).toMatchObject({
      tools: [
        'create_note',
        'edit_drawing',
        'edit_note',
        'get_links',
        'list_notes',
        'read_drawing',
        'read_note',
        'search_notes',
      ],
      read: 'Hello',
      outside: true,
      briefed: true,
      guided: true,
    });
    win.close();
  });

  it('starts a chat again after a start its end overtook', async () => {
    const s = await served({ 'note.md': 'Hello' }, { spawnDelay: 400 });
    const id = s.folder.vaultId;
    const token = (
      (await (await openWithKey(s.server, id, s.folder.key)).json()) as {
        token: string;
      }
    ).token;
    const win = await agentsSocket(s.server, id, token);
    await win.next((m) => m.t === 'hello');
    win.send({ t: 'new', id: 'slow-1', agent: s.mock });
    win.send({ t: 'auto', id: 'slow-1', on: true });
    win.send({ t: 'prompt', id: 'slow-1', req: 1, text: 'first' });
    await win.next((m) => m.t === 'done' && m.req === 1);
    win.send({ t: 'end', id: 'slow-1' });
    // Opened (its agent starting, slowly), ended before it is there, opened and asked again.
    win.send({ t: 'open', id: 'slow-1' });
    await sleep(100);
    win.send({ t: 'end', id: 'slow-1' });
    win.send({ t: 'open', id: 'slow-1' });
    win.send({ t: 'prompt', id: 'slow-1', req: 2, text: 'second' });
    const done = await win.next((m) => m.t === 'done' && m.req === 2);
    expect(done.error).toBeUndefined();
    await sleep(300);
    expect(agentsIn(s.root)).toBe(1);
    win.close();
  });

  it('outlives a malformed frame, and takes no chat id that names its files', async () => {
    const s = await served({});
    const id = s.folder.vaultId;
    const token = (
      (await (await openWithKey(s.server, id, s.folder.key)).json()) as {
        token: string;
      }
    ).token;
    const bad = await agentsSocket(s.server, id, token);
    await bad.next((m) => m.t === 'hello');
    // A frame with a reserved opcode.
    const closed = new Promise((r) => bad.raw.on('close', r));
    (bad.raw as unknown as { _socket: { write(b: Buffer): void } })._socket.write(
      Buffer.from([0x83, 0x80, 1, 2, 3, 4]),
    );
    await closed;
    const good = await agentsSocket(s.server, id, token);
    await good.next((m) => m.t === 'hello');
    good.send({ t: 'new', id: 'open', agent: s.mock });
    await good.next((m) => m.t === 'error' && /Not a new chat/.test(m.message));
    expect(s.disk('.pumice/chats/open.json')).toBeUndefined();
    good.close();
  });

  it('lets only who opened the vault in to its agents', async () => {
    const s = await served({});
    const refused = (url: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
      });
    const ws = s.server.url.replace('http', 'ws');
    expect(await refused(`${ws}/agents?vault=${s.folder.vaultId}&token=nope`)).toBe(401);
    const { token } = (await (
      await openWithKey(s.server, s.folder.vaultId, s.folder.key)
    ).json()) as {
      token: string;
    };
    expect(await refused(`${ws}/agents?vault=other&token=${token}`)).toBe(403);
    const folder = (as: string) =>
      fetch(`${s.server.url}/api/vaults/${s.folder.vaultId}/folder`, {
        headers: { Authorization: `Bearer ${as}` },
      });
    expect(((await (await folder(token)).json()) as { root: string }).root).toBe(
      realpathSync(s.root),
    );
    expect((await folder('not-a-token')).status).toBe(401);
  });
});

/** A window's connection to a vault's agent chats. */
async function agentsSocket(server: RunningServer, vault: string, token: string) {
  const ws = new WebSocket(
    `${server.url.replace('http', 'ws')}/agents?vault=${vault}&token=${token}`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seen: any[] = [];
  let wake = () => undefined as void;
  ws.on('message', (data) => {
    seen.push(JSON.parse(data.toString()));
    wake();
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  let from = 0;
  return {
    raw: ws,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    /** The next message (after the last one taken) that fits. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async next(fits: (m: any) => boolean, timeout = 15_000): Promise<any> {
      const start = Date.now();
      for (;;) {
        for (let i = from; i < seen.length; i++)
          if (fits(seen[i])) {
            from = i + 1;
            return seen[i];
          }
        if (Date.now() - start > timeout)
          throw new Error(
            `No such message; had: ${JSON.stringify(seen.slice(from)).slice(0, 800)}`,
          );
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 100);
        });
      }
    },
  };
}

/** How many test agents run in `root` (other tests run them elsewhere). */
function agentsIn(root: string): number {
  let pids: string[];
  try {
    pids = execFileSync('pgrep', ['-f', 'mock-agent.mjs']).toString().trim().split('\n');
  } catch {
    return 0;
  }
  const here = realpathSync(root);
  return pids.filter((pid) => {
    try {
      const cwd = existsSync(`/proc/${pid}/cwd`)
        ? realpathSync(`/proc/${pid}/cwd`)
        : /\nn(.*)/.exec(
            execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).toString(),
          )?.[1];
      return cwd === here;
    } catch {
      return false;
    }
  }).length;
}
