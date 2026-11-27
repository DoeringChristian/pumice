import { markdownText } from '@pumice/api';
import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { VaultImpl } from '@pumice/core-vault';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { startServer, type RunningServer } from '@pumice/server/src/server.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollabClient } from '../src/client';
import { SharedVault } from '../src/shared-vault';

let server: RunningServer;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pumice-server-'));
  server = await startServer({ dataDir, devLogin: true, sendLoginCode: () => undefined });
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function signIn(email: string) {
  const client = new CollabClient(server.url, undefined);
  const { code } = await client.requestCode(email);
  const { user } = await client.verify(email, code!, email.split('@')[0]);
  return { client, user };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k: string) => map.get(k),
    set: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
  };
}

async function device(
  email: string,
  files: Record<string, string>,
  vaultId: string | ((client: CollabClient) => Promise<string>),
  opts: {
    seed?: boolean;
    role?: 'owner' | 'editor' | 'viewer';
    storage?: ReturnType<typeof memoryStorage>;
    signedIn?: Awaited<ReturnType<typeof signIn>>;
  } = {},
) {
  const platform = createMemoryPlatform({ files });
  const vault = new VaultImpl(platform);
  await vault.load();
  const documents = new DocumentsImpl(vault, { saveDelay: 0 });
  documents.registerCodec(markdownCodec);
  const { client, user } = opts.signedIn ?? (await signIn(email));
  const id = typeof vaultId === 'string' ? vaultId : await vaultId(client);
  const storage = opts.storage ?? memoryStorage();
  const shared = new SharedVault({
    client,
    vaultId: id,
    user,
    role: opts.role ?? 'owner',
    vault,
    documents,
    storage,
  });
  documents.registerProvider(shared.provider());
  client.connect();
  await waitFor(() => client.state === 'online', 'connection');
  await shared.start({ seedFromDisk: !!opts.seed });
  const read = (p: string) => platform.fs.snapshot()[p];
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await vault.settled();
      await documents.idle();
      await shared.idle();
      await sleep(20);
    }
  };
  return { platform, vault, documents, client, user, shared, read, settle, storage, vaultId: id };
}

describe('shared vaults', () => {
  it('shares a vault, syncs edits both ways, renames, deletes and attachments', async () => {
    const a = await device(
      'ada@example.com',
      {
        'Note.md': '# Note\n\nline one\nline two\n',
        'Folder/Other.md': 'other',
        'img.png': 'PNGDATA',
      },
      async (c) => (await c.createVault('Team')).id,
      { seed: true },
    );
    const invite = await a.client.invite(a.vaultId, 'editor');

    const bob = await signIn('bob@example.com');
    await bob.client.acceptInvite(invite.token);
    const b = await device('bob@example.com', {}, a.vaultId, { role: 'editor', signedIn: bob });

    await waitFor(
      () =>
        b.read('Note.md') === '# Note\n\nline one\nline two\n' &&
        b.read('Folder/Other.md') === 'other' &&
        b.read('img.png') === 'PNGDATA',
      'initial sync to B',
    );

    // A edits through an open document (as the editor does).
    const h = await a.documents.open('Note.md');
    markdownText(h.doc).insert(markdownText(h.doc).length, 'from A\n');
    await a.settle();
    await waitFor(() => b.read('Note.md')?.endsWith('from A\n') ?? false, 'A edit on B');
    h.dispose();

    // B edits the file on disk (another editor); A sees it.
    b.platform.fs.external.write('Note.md', b.read('Note.md')!.replace('line one', 'line ONE (B)'));
    await waitFor(
      () => a.read('Note.md')?.includes('line ONE (B)') ?? false,
      'B external edit on A',
    );

    // Renames and deletes.
    await b.vault.rename('Folder/Other.md', 'Moved.md');
    await sleep(500);
    if (process.env.COLLAB_DEBUG) {
      console.log(
        'A files',
        Object.keys(a.platform.fs.snapshot()),
        'A manifest',
        JSON.stringify(a.shared.files.toJSON()),
      );
      console.log(
        'B files',
        Object.keys(b.platform.fs.snapshot()),
        'B manifest',
        JSON.stringify(b.shared.files.toJSON()),
      );
    }
    await waitFor(
      () => a.read('Moved.md') === 'other' && a.read('Folder/Other.md') === undefined,
      'rename on A',
    );
    await a.vault.delete('Moved.md');
    await waitFor(() => b.read('Moved.md') === undefined, 'delete on B');

    // A new attachment travels as a blob.
    await b.vault.create('photo.jpg', new TextEncoder().encode('JPEGDATA'));
    await waitFor(() => a.read('photo.jpg') === 'JPEGDATA', 'blob to A');

    a.client.disconnect();
    b.client.disconnect();
    a.shared.dispose();
    b.shared.dispose();
  }, 20_000);

  it('brings notes created after a device joined to it', async () => {
    const a = await device(
      'eve@example.com',
      { 'First.md': 'first\n' },
      async (c) => (await c.createVault('Later notes')).id,
      { seed: true },
    );
    const inv = await a.client.invite(a.vaultId, 'editor');
    const fay = await signIn('fay@example.com');
    await fay.client.acceptInvite(inv.token);
    const b = await device('fay@example.com', {}, a.vaultId, { signedIn: fay });
    await waitFor(() => b.read('First.md') === 'first\n', 'initial');

    a.platform.fs.external.write('Second.md', 'second\n');
    await waitFor(() => b.read('Second.md') === 'second\n', 'a note created after joining');
    await b.vault.create('Third.md', 'third\n');
    await waitFor(() => a.read('Third.md') === 'third\n', 'and the other way');
  });

  it('merges concurrent offline edits when devices reconnect', async () => {
    const a = await device(
      'cy@example.com',
      { 'Doc.md': 'one\ntwo\nthree\n' },
      async (c) => (await c.createVault('Offline')).id,
      { seed: true },
    );
    const inv = await a.client.invite(a.vaultId, 'editor');
    const dee = await signIn('dee@example.com');
    await dee.client.acceptInvite(inv.token);
    const b = await device('dee@example.com', {}, a.vaultId, { signedIn: dee });
    await waitFor(() => b.read('Doc.md') === 'one\ntwo\nthree\n', 'initial');

    a.client.disconnect();
    b.client.disconnect();
    a.platform.fs.external.write('Doc.md', 'ONE\ntwo\nthree\n');
    b.platform.fs.external.write('Doc.md', 'one\ntwo\nTHREE\n');
    await a.settle();
    await b.settle();
    a.client.connect();
    b.client.connect();
    await waitFor(
      () => a.read('Doc.md') === 'ONE\ntwo\nTHREE\n' && b.read('Doc.md') === 'ONE\ntwo\nTHREE\n',
      'converged',
    );

    a.client.disconnect();
    b.client.disconnect();
    a.shared.dispose();
    b.shared.dispose();
  }, 20_000);

  it('restarts from the persisted replica and picks up changes made while closed', async () => {
    const storage = memoryStorage();
    const a = await device(
      'eve@example.com',
      { 'X.md': 'start\n' },
      async (c) => (await c.createVault('Restart')).id,
      { seed: true, storage },
    );
    await a.settle();
    await a.shared.flush();
    a.client.disconnect();
    a.shared.dispose();
    // Edited while Pumice was closed.
    const files = {
      ...a.platform.fs.snapshot(),
      'X.md': 'start\nedited offline\n',
      'New.md': 'new',
    };
    const again = await device('eve@example.com', files, a.vaultId, { storage });
    const inv = await again.client.invite(a.vaultId, 'viewer');
    const fay = await signIn('fay@example.com');
    await fay.client.acceptInvite(inv.token);
    const viewer = await device('fay@example.com', {}, a.vaultId, {
      role: 'viewer',
      signedIn: fay,
    });
    await waitFor(
      () => viewer.read('X.md') === 'start\nedited offline\n' && viewer.read('New.md') === 'new',
      'offline changes reach others',
    );

    // A viewer's edits are not accepted.
    viewer.platform.fs.external.write('X.md', 'vandalized');
    await viewer.settle();
    await sleep(200);
    expect(again.read('X.md')).toBe('start\nedited offline\n');

    for (const d of [again, viewer]) {
      d.client.disconnect();
      d.shared.dispose();
    }
  }, 20_000);
});
