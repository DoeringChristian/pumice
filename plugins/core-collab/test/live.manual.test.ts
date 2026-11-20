// Manual check against a running server: LIVE_INVITE=<token> npx vitest run plugins/core-collab/test/live.manual.test.ts
import { markdownText } from '@pumice/api';
import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { VaultImpl } from '@pumice/core-vault';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { it } from 'vitest';
import { CollabClient } from '../src/client';
import { SharedVault } from '../src/shared-vault';

it.runIf(process.env.LIVE_INVITE)(
  'joins and types into Welcome',
  async () => {
    const client = new CollabClient(process.env.LIVE_SERVER ?? 'http://127.0.0.1:8787', undefined);
    const { code } = await client.requestCode('bob@example.com');
    const { user } = await client.verify('bob@example.com', code!, 'Bob');
    const info = await client.acceptInvite(process.env.LIVE_INVITE!);
    const platform = createMemoryPlatform({});
    const vault = new VaultImpl(platform);
    await vault.load();
    const documents = new DocumentsImpl(vault, { saveDelay: 0 });
    documents.registerCodec(markdownCodec);
    const store = new Map<string, string>();
    const shared = new SharedVault({
      client,
      vaultId: info.id,
      user,
      role: info.role,
      vault,
      documents,
      storage: {
        get: async (k) => store.get(k),
        set: async (k, v) => void store.set(k, v),
        delete: async (k) => void store.delete(k),
      },
    });
    await shared.init();
    documents.registerProvider(shared.provider());
    client.connect();
    await shared.run();
    for (let i = 0; i < 100 && !platform.fs.snapshot()['Welcome.md']; i++)
      await new Promise((r) => setTimeout(r, 50));
    console.log('Bob has', Object.keys(platform.fs.snapshot()).length, 'files');
    const h = await documents.open('Welcome.md');
    const text = markdownText(h.doc);
    const at = text.toString().indexOf('Pumice is a');
    for (const ch of 'Bob was here. ') {
      text.insert(at + (text.toString().indexOf('Pumice is a') - at), ch);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 4000));
    h.dispose();
    client.disconnect();
  },
  30_000,
);
