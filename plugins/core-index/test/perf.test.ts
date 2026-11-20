import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { MarkdownSyntaxImpl } from '@pumice/core-markdown';
import { VaultImpl } from '@pumice/core-vault';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { expect, it } from 'vitest';
import { MetadataIndexImpl, inlineParser } from '../src';

// Run with PERF=1 (prints timings; budgets from docs/plan/04 are for a mid-range laptop).
const N = Number(process.env.PERF_NOTES ?? 10000);

it.runIf(process.env.PERF)(
  `indexes ${N} notes`,
  async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < N; i++) {
      const links = Array.from({ length: 8 }, (_, k) => `[[Note ${(i * 7 + k * 13) % N}]]`).join(
        ', ',
      );
      files[`folder ${i % 50}/Note ${i}.md`] =
        `---\nid: ${i.toString(32).padStart(10, '0')}\ntags: [t${i % 20}]\n---\n# Note ${i}\n\nSome text about topic ${i % 97} with ${links}.\n\n## Details\n\n- [ ] task #todo\n- item ==mark== $x^${i}$\n\n> [!note] Callout\n> body ^b${i}\n`;
    }
    const platform = createMemoryPlatform({ files });
    const vault = new VaultImpl(platform);
    await vault.load();
    const docs = new DocumentsImpl(vault, { saveDelay: 0 });
    docs.registerCodec(markdownCodec);
    const syntax = new MarkdownSyntaxImpl();
    const store = new Map<string, string>();
    const storage = {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    };

    let t = performance.now();
    const cold = new MetadataIndexImpl({
      vault,
      documents: docs,
      parser: inlineParser((x) => syntax.extract(x)),
      storage,
      persistDelay: 0,
    });
    await cold.start();
    await cold.ready;
    const coldMs = performance.now() - t;
    t = performance.now();
    const backlinks = cold.backlinks('folder 0/Note 0.md').length;
    const resolveMs = performance.now() - t;
    await cold.flush();
    cold.dispose();

    t = performance.now();
    const warm = new MetadataIndexImpl({
      vault,
      documents: docs,
      parser: inlineParser((x) => syntax.extract(x)),
      storage,
    });
    await warm.start();
    await warm.ready;
    const warmMs = performance.now() - t;
    t = performance.now();
    const hits = await warm.search('topic 42');
    const searchMs = performance.now() - t;
    console.log(
      `${N} notes: cold index ${coldMs.toFixed(0)} ms, first link resolution ${resolveMs.toFixed(0)} ms, warm start ${warmMs.toFixed(0)} ms, search ${searchMs.toFixed(0)} ms (${hits.length} hits), snapshot ${(store.get('snapshot')!.length / 1e6).toFixed(1)} MB`,
    );
    expect(backlinks).toBeGreaterThan(0);
  },
  120_000,
);
