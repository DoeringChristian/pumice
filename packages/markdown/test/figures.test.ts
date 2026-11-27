import { describe, expect, it } from 'vitest';
import {
  figureLabel,
  figureReference,
  itemByNumber,
  labelChange,
  newLabel,
  numberItems,
  referableItems,
  renameLabelChanges,
  validLabel,
} from '../src/figures';
import { parseEmbedSize, withAliasSize } from '../src/links';
import { embedCaption, isFigureTarget, mediaIn } from '../src/media';

const NOTE = `---
title: x
---
# Results

![[plain.png]]

![[lucy.png|Lucy, scanned at 250k triangles|300]] ^fig-lucy

As [[#^fig-lucy]] shows.

![[a.png|Left]] ![[b.png|200]] ![[c.png|Right|200]]

![[Other note|not a figure]]

\`\`\`frame
file: [[frames/bars/index.html]]
caption: "Words per note" # the figure
\`\`\`
^fig-words

\`\`\`frame
file: [[frames/bars/index.html]]
\`\`\`

\`\`\`md
![[inside-code.png|Not counted]]
\`\`\`

Table: Runs and their error

| run | error |
| --- | --- |
| a | 0.1 |

^tab-runs

| no | caption |
| --- | --- |

$$
E = mc^2
$$ ^eq-energy

$$ a = b $$

$$
c = d
$$
^eq-second
`;

describe('numberItems', () => {
  const items = numberItems(NOTE);
  const brief = items.map((i) => `${figureLabel(i)}|${i.id ?? ''}|${i.caption ?? ''}`);

  it('numbers what has a caption or a label, in order', () => {
    expect(brief).toEqual([
      'Figure 1|fig-lucy|Lucy, scanned at 250k triangles',
      'Figure 2||Left',
      'Figure 3||Right',
      'Figure 4|fig-words|Words per note',
      'Table 1|tab-runs|Runs and their error',
      'Equation 1|eq-energy|',
      'Equation 2|eq-second|',
    ]);
  });

  it('says where each one is among all of its kind', () => {
    // plain.png is the first picture, a/b/c the 3rd to 5th, the frames the 6th and 7th.
    expect(items.filter((i) => i.kind === 'fig').map((i) => i.ordinal)).toEqual([1, 2, 4, 5]);
    expect(items.filter((i) => i.kind === 'tab').map((i) => i.ordinal)).toEqual([0]);
    expect(items.filter((i) => i.kind === 'eq').map((i) => i.ordinal)).toEqual([0, 2]);
  });

  it('knows lines and columns', () => {
    const lines = NOTE.split('\n');
    const lucy = items[0]!;
    expect(lines[lucy.line]).toContain('lucy.png');
    expect(items[2]!.column).toBe(lines[items[2]!.line]!.indexOf('![[c.png'));
    const table = items.find((i) => i.kind === 'tab')!;
    expect(lines[table.captionLine!]).toBe('Table: Runs and their error');
    expect(lines[table.line]).toBe('| run | error |');
  });

  it('writes references', () => {
    expect(figureReference(items[0]!)).toBe('Figure 1');
    expect(figureReference(items.find((i) => i.kind === 'tab')!)).toBe('Table 1');
    expect(figureReference(items.find((i) => i.kind === 'eq')!)).toBe('Equation 1');
  });

  it('renumbers when the order changes', () => {
    const moved = numberItems('![[b.png|B]] ^fig-b\n\n![[a.png|A]] ^fig-a\n');
    expect(moved.map((i) => `${i.id}=${i.number}`)).toEqual(['fig-b=1', 'fig-a=2']);
  });
});

describe('captions and targets', () => {
  it('takes the caption from an alias', () => {
    expect(embedCaption('Loss over time|400')).toBe('Loss over time');
    expect(embedCaption('Loss over time')).toBe('Loss over time');
    expect(embedCaption('400')).toBeUndefined();
    expect(embedCaption('400x200')).toBeUndefined();
    expect(embedCaption(undefined)).toBeUndefined();
    // An empty size: what is before it is the caption, though it reads as a size.
    expect(embedCaption('2024|')).toBe('2024');
    expect(embedCaption('2024|300')).toBe('2024');
    expect(parseEmbedSize('2024|')).toEqual({});
    expect(withAliasSize('2024|', '300')).toBe('2024|300');
    const [media] = mediaIn('![[a.png|2024|]]');
    expect(media).toMatchObject({ caption: '2024', size: {} });
    expect('![[a.png|2024|]]'.slice(media!.captionFrom, media!.captionTo)).toBe('2024');
  });
  it('tells figures from embedded notes', () => {
    expect(isFigureTarget('plot.png')).toBe(true);
    expect(isFigureTarget('frames/bars/index.html')).toBe(true);
    expect(isFigureTarget('Sketch.excalidraw')).toBe(true);
    expect(isFigureTarget('Other note')).toBe(false);
    expect(isFigureTarget('Other note.md')).toBe(false);
  });
});

describe('labels and references', () => {
  const note = [
    'Text.',
    '',
    '![[a.png|First]]',
    '',
    '![[b.png|As in [[#^fig-a]] again|350]] ^fig-b',
    '',
    '$$',
    'x = 1',
    '$$',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    'See [[#^fig-b]] and [[#^fig-b|that one]], @fig-b too (not @fig-bb).',
  ].join('\n');
  const apply = (text: string, c: { from: number; to: number; insert: string }) =>
    text.slice(0, c.from) + c.insert + text.slice(c.to);

  it('reads a caption that refers to another figure', () => {
    const items = numberItems(note);
    expect(items.map((i) => [i.kind, i.number, i.caption, i.id])).toEqual([
      ['fig', 1, 'First', undefined],
      ['fig', 2, 'As in [[#^fig-a]] again', 'fig-b'],
    ]);
  });

  it('lists what has no number too, and labels it', () => {
    const items = referableItems(note);
    expect(items.map((i) => `${i.kind}${i.number}`)).toEqual(['fig1', 'fig2', 'eq0', 'tab0']);
    const withFig = apply(note, labelChange(note, items[0]!, 'fig-new'));
    expect(withFig).toContain('![[a.png|First]]{#fig-new}\n');
    expect(numberItems(withFig)[0]!.id).toBe('fig-new');
    const withEq = apply(note, labelChange(note, items[2]!, 'eq-new'));
    expect(withEq).toContain('x = 1\n$$ {#eq-new}\n');
    expect(numberItems(withEq).find((i) => i.kind === 'eq')?.id).toBe('eq-new');
    const withTab = apply(note, labelChange(note, items[3]!, 'tab-new'));
    expect(withTab).toContain('Table: {#tab-new}\n\n| a | b |');
    expect(numberItems(withTab).find((i) => i.kind === 'tab')?.id).toBe('tab-new');
  });

  it('gives each picture of a line its own label, whatever follows', () => {
    const row = '![[a.png|200]] ![[b.png|200]]{width=50%} and text after.';
    const [a, b] = referableItems(row);
    let text = apply(row, labelChange(row, b!, 'fig-b'));
    text = apply(text, labelChange(text, referableItems(text)[0]!, 'fig-a'));
    expect(text).toBe('![[a.png|200]]{#fig-a} ![[b.png|200]]{#fig-b width=50%} and text after.');
    expect(numberItems(text).map((i) => i.id)).toEqual(['fig-a', 'fig-b']);
    expect(a!.number).toBe(0);
    // As a block ID at the end of the line it is the first picture's that has none.
    expect(numberItems('![[a.png]]{#fig-a} ![[b.png]] ^fig-old').map((i) => i.id)).toEqual([
      'fig-a',
      'fig-old',
    ]);
  });

  it('reads the label of a table from its caption line, of a frame from its block', () => {
    const text = [
      'Table: Runs {#tab-runs}',
      '',
      '| a |',
      '| - |',
      '',
      '```frame',
      'file: [[f.html]]',
      'label: fig-frame',
      '```',
      '',
      '$$ x $$ {#eq-one}',
    ].join('\n');
    expect(numberItems(text).map((i) => [i.id, i.caption])).toEqual([
      ['tab-runs', 'Runs'],
      ['fig-frame', undefined],
      ['eq-one', undefined],
    ]);
    const plain = '```frame\nfile: [[f.html]]\n```';
    expect(apply(plain, labelChange(plain, referableItems(plain)[0]!, 'fig-x'))).toBe(
      '```frame\nlabel: fig-x\nfile: [[f.html]]\n```',
    );
    let renamed = text;
    for (const [from, to] of [
      ['tab-runs', 'tab-r'],
      ['fig-frame', 'fig-f'],
      ['eq-one', 'eq-1'],
    ] as const)
      for (const c of renameLabelChanges(renamed, from, to).reverse()) renamed = apply(renamed, c);
    expect(numberItems(renamed).map((i) => i.id)).toEqual(['tab-r', 'fig-f', 'eq-1']);
  });

  it('finds what a reference by number means', () => {
    const items = numberItems(note);
    expect(itemByNumber(items, 'fig2')?.id).toBe('fig-b');
    expect(itemByNumber(items, 'fig-1')?.caption).toBe('First');
    expect(itemByNumber(items, 'fig3')).toBeUndefined();
    expect(itemByNumber(items, 'fig-b')).toBeUndefined();
  });

  it('renames links of either form', () => {
    let text = 'See [[#fig-b]], [[#^fig-b|it]], [[#fig-bc]].\n\n![[a.png]]{#fig-b}\n';
    for (const c of renameLabelChanges(text, 'fig-b', 'fig-x').reverse()) text = apply(text, c);
    expect(text).toBe('See [[#fig-x]], [[#^fig-x|it]], [[#fig-bc]].\n\n![[a.png]]{#fig-x}\n');
  });

  it('renames a label and the links to it', () => {
    let text = note;
    for (const c of renameLabelChanges(note, 'fig-b', 'fig-setup').reverse()) text = apply(text, c);
    expect(text).toContain('|350]] ^fig-setup\n');
    expect(text).toContain(
      '[[#^fig-setup]] and [[#^fig-setup|that one]], @fig-setup too (not @fig-bb).',
    );
    expect(text).toContain('[[#^fig-a]]');
    expect(validLabel('fig', 'fig-setup')).toBe(true);
    expect(validLabel('fig', 'setup')).toBe(false);
    expect(newLabel('eq', note, () => 0)).toBe('eq-00000');
  });
});
