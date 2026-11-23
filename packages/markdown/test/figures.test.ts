import { describe, expect, it } from 'vitest';
import {
  embedCaption,
  figureLabel,
  figureReference,
  isFigureTarget,
  numberItems,
} from '../src/figures';

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
    expect(figureReference(items.find((i) => i.kind === 'eq')!)).toBe('(1)');
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
  });
  it('tells figures from embedded notes', () => {
    expect(isFigureTarget('plot.png')).toBe(true);
    expect(isFigureTarget('frames/bars/index.html')).toBe(true);
    expect(isFigureTarget('Sketch.excalidraw')).toBe(true);
    expect(isFigureTarget('Other note')).toBe(false);
    expect(isFigureTarget('Other note.md')).toBe(false);
  });
});

describe('setting a caption', () => {
  it('writes it between the target and the size', async () => {
    const { setEmbedCaption } = await import('../src/figures');
    expect(setEmbedCaption('pic.png', 'A view')).toBe('pic.png|A view');
    expect(setEmbedCaption('pic.png|300', 'A view')).toBe('pic.png|A view|300');
    expect(setEmbedCaption('pic.png|Old|300x200', 'New')).toBe('pic.png|New|300x200');
    expect(setEmbedCaption('folder/pic.png#page=2|Old', 'New')).toBe('folder/pic.png#page=2|New');
  });
  it('removes it when it is empty, keeping the size', async () => {
    const { setEmbedCaption } = await import('../src/figures');
    expect(setEmbedCaption('pic.png|Old|300', '  ')).toBe('pic.png|300');
    expect(setEmbedCaption('pic.png|Old', '')).toBe('pic.png');
  });
  it('keeps out what would break the embed', async () => {
    const { setEmbedCaption } = await import('../src/figures');
    expect(setEmbedCaption('pic.png', 'a | b ]] c')).toBe('pic.png|a b c');
  });
});
