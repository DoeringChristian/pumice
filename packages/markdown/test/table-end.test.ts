import { parser as baseParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src';
import { dialectExtensions } from '../src/lezer';

const NOTE = `| name | score |
| --- | --- |
| ann | 1 |
| bob | 2 |
Text right under the table, with **bold** and a [[link]].
Second line of that text.

After.
`;

describe('a table ends at the first line without a pipe', () => {
  it('in the tree the reading view and the index use', () => {
    const tree = parseMarkdown(NOTE);
    expect(tree.children.map((n) => n.type)).toEqual(['table', 'paragraph', 'paragraph']);
    const [table, text] = tree.children as Array<{
      children: unknown[];
      position: { start: { offset: number; line: number }; end: { offset: number } };
    }>;
    expect(table!.children).toHaveLength(3);
    expect(NOTE.slice(table!.position.start.offset, table!.position.end.offset)).toBe(
      '| name | score |\n| --- | --- |\n| ann | 1 |\n| bob | 2 |',
    );
    // The text keeps its formatting, and knows where it is in the note.
    expect(NOTE.slice(text!.position.start.offset, text!.position.end.offset)).toBe(
      'Text right under the table, with **bold** and a [[link]].\nSecond line of that text.',
    );
    expect(text!.position.start.line).toBe(5);
    expect(JSON.stringify(text)).toContain('"strong"');
    expect(JSON.stringify(text)).toContain('"wikiLink"');
  });

  it('in the tree the editor uses', () => {
    const tree = baseParser.configure(dialectExtensions).parse(NOTE);
    const blocks: string[] = [];
    const cursor = tree.topNode.cursor();
    if (cursor.firstChild())
      do blocks.push(`${cursor.name}:${NOTE.slice(cursor.from, cursor.to).split('\n').length}`);
      while (cursor.nextSibling());
    expect(blocks).toEqual(['Table:4', 'Paragraph:2', 'Paragraph:1']);
  });

  it('leaves ordinary tables and rows without outer pipes alone', () => {
    const plain = '| a | b |\n| - | - |\n| 1 | 2 |\n\nText.\n';
    expect(parseMarkdown(plain).children.map((n) => n.type)).toEqual(['table', 'paragraph']);
    const loose = 'a | b\n--- | ---\n1 | 2\n3 | 4\n';
    const table = parseMarkdown(loose).children[0] as { type: string; children: unknown[] };
    expect([table.type, table.children.length]).toEqual(['table', 3]);
  });

  it('gives a label right under a table to the table', () => {
    const tree = parseMarkdown('| a |\n| - |\n| 1 |\n^tab-x\n');
    expect(tree.children.map((n) => n.type)).toEqual(['table', 'paragraph']);
  });
});
