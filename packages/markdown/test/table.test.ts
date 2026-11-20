import { describe, expect, it } from 'vitest';
import {
  deleteColumn,
  escapeCell,
  formatTable,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  setAlign,
  sortRows,
  tableData,
  tableFromDelimited,
  unescapeCell,
} from '../src/table';

const src = `| Name | Qty |
|:-----|----:|
| apples | 10 |
| [[abc\\|Pears]] |2
`;

describe('tables', () => {
  it('parses cells with offsets, alignment and escaped pipes', () => {
    const t = parseTable(src)!;
    expect(t.header.map((c) => c.text)).toEqual(['Name', 'Qty']);
    expect(t.align).toEqual(['left', 'right']);
    expect(t.rows.map((r) => r.map((c) => c.text))).toEqual([
      ['apples', '10'],
      ['[[abc\\|Pears]]', '2'],
    ]);
    for (const c of [...t.header, ...t.rows.flat()]) expect(src.slice(c.from, c.to)).toBe(c.text);
  });

  it('pads missing cells at the end of the line and keeps extra cells', () => {
    const t = parseTable('a | b\n--|--\n1\n1 | 2 | 3\n')!;
    expect(t.rows[0]!.map((c) => c.text)).toEqual(['1', '']);
    expect(t.rows[0]![1]!.from).toBe('a | b\n--|--\n1'.length);
    expect(t.extra).toEqual([[], [], ['3']]);
    expect(formatTable(tableData(t))).toBe(
      '| a   | b   |\n| --- | --- |\n| 1   |     |\n| 1   | 2   | 3 |',
    );
  });

  it('rejects non-tables', () => {
    expect(parseTable('just | text\nmore text')).toBeNull();
  });

  it('formats with alignment', () => {
    expect(formatTable(tableData(parseTable(src)!))).toBe(
      [
        '| Name           | Qty |',
        '| :------------- | --: |',
        '| apples         |  10 |',
        '| [[abc\\|Pears]] |   2 |',
      ].join('\n'),
    );
  });

  it('edits structure', () => {
    let d = tableData(parseTable(src)!);
    d = insertRow(d, 0);
    expect(d.rows[0]).toEqual(['', '']);
    d = insertColumn(d, 1, 'Mid');
    expect(d.header).toEqual(['Name', 'Mid', 'Qty']);
    expect(d.align).toEqual(['left', null, 'right']);
    d = moveColumn(d, 2, 0);
    expect(d.header).toEqual(['Qty', 'Name', 'Mid']);
    d = deleteColumn(d, 2);
    d = moveRow(d, 0, 2);
    expect(d.rows.map((r) => r[1])).toEqual(['apples', '[[abc\\|Pears]]', '']);
    d = sortRows(d, 0);
    expect(d.rows.map((r) => r[0])).toEqual(['', '2', '10']);
    d = sortRows(d, 0, true);
    expect(d.rows.map((r) => r[0])).toEqual(['10', '2', '']);
    d = setAlign(d, 0, 'center');
    expect(formatTable(d).split('\n')[1]).toBe('| :-: | :------------- |');
  });

  it('escapes and unescapes cells', () => {
    expect(escapeCell('a | b || c')).toBe('a \\| b \\|\\| c');
    expect(escapeCell('already \\| fine')).toBe('already \\| fine');
    expect(escapeCell('two\nlines')).toBe('two<br>lines');
    expect(unescapeCell('a \\| b')).toBe('a | b');
  });

  it('converts CSV and TSV', () => {
    expect(tableFromDelimited('a\tb\n1\t2\n')?.rows).toEqual([['1', '2']]);
    expect(tableFromDelimited('name,note\nx,"has, comma ""quoted"""\ny')).toEqual({
      header: ['name', 'note'],
      align: [null, null],
      rows: [
        ['x', 'has, comma "quoted"'],
        ['y', ''],
      ],
      extra: [],
    });
    expect(tableFromDelimited('no separators here')).toBeNull();
  });
});
