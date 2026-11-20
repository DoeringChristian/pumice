import { expect, it } from 'vitest';
import { obsidianReport, reportMarkdown, scrubStack } from '../src';

it('reports plugins and unsupported syntax', async () => {
  const files: Record<string, string> = {
    '.obsidian/community-plugins.json': JSON.stringify([
      'dataview',
      'obsidian-excalidraw-plugin',
      'some-unknown',
    ]),
    '.obsidian/core-plugins.json': JSON.stringify({ canvas: true, backlink: true, sync: false }),
    'a.md': '# A\n```dataview\nLIST\n```\n',
    'b.md': 'status:: done\n<% tp.date.now() %>',
    'Drawing.excalidraw.md': '',
    'board.canvas': '{}',
  };
  const items = await obsidianReport({ paths: Object.keys(files), read: async (p) => files[p] });
  const titles = items.map((i) => `${i.level}:${i.title}`);
  expect(titles).toContain('warning:Community plugin: dataview');
  expect(titles).toContain('ok:Community plugin: obsidian-excalidraw-plugin');
  expect(titles).toContain('warning:Community plugin: some-unknown');
  expect(titles).toContain('warning:Core plugin: canvas');
  expect(titles).toContain('ok:Core plugin: backlink');
  expect(titles).toContain('warning:Dataview queries');
  expect(titles).toContain('warning:Templater commands');
  expect(titles).toContain('warning:Dataview inline fields (key:: value)');
  expect(titles).toContain('ok:1 Excalidraw drawings');
  expect(reportMarkdown(items)).toContain('- ⚠️ **Dataview queries**');
});

it('scrubs stacks down to frames without paths', () => {
  const stack =
    'Error: secret note text\n    at foo (http://localhost:5199/src/a/b.ts:10:5)\n    at bar (file:///Users/me/vault/x.js:1:2)';
  expect(scrubStack(stack)).toBe('    at foo (b.ts:10:5)\n    at bar (x.js:1:2)');
});
