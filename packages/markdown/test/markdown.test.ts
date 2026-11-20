import { describe, expect, test } from 'vitest';
import {
  applyChange,
  deleteProperty,
  extractMetadata,
  formatWikiLink,
  frontmatterBounds,
  generateId,
  isNoteId,
  parseWikiLinkContent,
  setProperty,
} from '../src';

describe('ids', () => {
  test('generated ids match the pattern', () => {
    for (let i = 0; i < 200; i++) expect(isNoteId(generateId())).toBe(true);
    expect(isNoteId('k7f3qm2xa1')).toBe(true);
    expect(isNoteId('K7F3QM2XA1')).toBe(false);
    expect(isNoteId('k7f3qm2xai')).toBe(false); // no i
    expect(isNoteId('Meeting')).toBe(false);
  });
});

describe('wikilink grammar', () => {
  test('parse and format', () => {
    expect(parseWikiLinkContent('a#b|c')).toEqual({ target: 'a', subpath: 'b', alias: 'c' });
    expect(parseWikiLinkContent('a\\|c')).toEqual({ target: 'a', alias: 'c' });
    expect(parseWikiLinkContent('#^x')).toEqual({ target: '', subpath: '^x' });
    expect(formatWikiLink({ target: 'k7f3qm2xa1', alias: 'Name' })).toBe('[[k7f3qm2xa1|Name]]');
    expect(formatWikiLink({ target: 'x', alias: 'y' }, { inTable: true, embed: true })).toBe(
      '![[x\\|y]]',
    );
  });
});

describe('metadata', () => {
  const text = `---
id: k7f3qm2xa1
aliases: [Alpha, "Beta"]
tags: [project, "#review"]
title: Display
---
# Intro #inline

See [[r2p9dz4wn8|Other]] and [md](Some%20note.md#Part) and ![[pic.png|200]] and [web](https://x.y).

- [ ] open task
- [x] done task ^task-1

| a |
| - |
| b |

^tbl
`;
  const meta = extractMetadata(text);

  test('frontmatter', () => {
    expect(meta.frontmatter?.id).toBe('k7f3qm2xa1');
    expect(meta.title).toBe('Display');
    expect(meta.aliases).toEqual(['Alpha', 'Beta']);
    expect(meta.tags.map((t) => t.tag)).toEqual(['project', 'review', 'inline']);
    expect(text.slice(meta.frontmatterRange!.from, meta.frontmatterRange!.to)).toMatch(
      /^---[\s\S]*---$/,
    );
  });

  test('links', () => {
    expect(
      meta.links.map(({ kind, target, subpath, alias }) => ({ kind, target, subpath, alias })),
    ).toEqual([
      { kind: 'link', target: 'r2p9dz4wn8', subpath: undefined, alias: 'Other' },
      { kind: 'mdlink', target: 'Some note.md', subpath: 'Part', alias: 'md' },
      { kind: 'embed', target: 'pic.png', subpath: undefined, alias: '200' },
    ]);
  });

  test('headings, tasks, blocks', () => {
    expect(meta.headings).toMatchObject([{ level: 1, text: 'Intro #inline' }]);
    expect(meta.tasks).toMatchObject([
      { text: 'open task', done: false },
      { text: 'done task', done: true },
    ]);
    const [task, table] = meta.blocks;
    expect(task!.id).toBe('task-1');
    expect(text.slice(task!.from, task!.to)).toBe('- [x] done task ^task-1');
    expect(table!.id).toBe('tbl');
    expect(text.slice(table!.from, table!.to)).toBe('| a |\n| - |\n| b |');
  });

  test('broken yaml is reported, not thrown', () => {
    const m = extractMetadata('---\nid: [unclosed\n---\nbody');
    expect(m.frontmatterError).toBeTruthy();
    expect(m.id).toBeUndefined();
  });
});

describe('frontmatter editing', () => {
  test('keeps comments and order', () => {
    const text = '---\n# comment\ntitle: x   # trailing\ntags: [a]\n---\nBody\n';
    const out = applyChange(text, setProperty(text, 'id', 'k7f3qm2xa1'));
    expect(out.startsWith('---\n# comment\ntitle: x')).toBe(true);
    expect(out).toContain('# comment');
    expect(out.endsWith('id: k7f3qm2xa1\n---\nBody\n')).toBe(true);
  });

  test('creates the block when missing; CRLF preserved', () => {
    expect(applyChange('Body', setProperty('Body', 'id', 'abc'))).toBe('---\nid: abc\n---\nBody');
    const crlf = '---\r\na: 1\r\n---\r\nBody';
    expect(applyChange(crlf, setProperty(crlf, 'b', 2))).toBe('---\r\na: 1\r\nb: 2\r\n---\r\nBody');
  });

  test('delete and bounds', () => {
    const text = '---\na: 1\nb: 2\n---\n';
    expect(applyChange(text, deleteProperty(text, 'a'))).toBe('---\nb: 2\n---\n');
    expect(frontmatterBounds('---\n---\nx')).toMatchObject({ from: 0, to: 8 });
    expect(frontmatterBounds('--- \nx')).toBeUndefined();
  });

  test('invalid yaml is left alone', () => {
    expect(setProperty('---\na: [\n---\n', 'b', 1)).toBeNull();
  });
});
