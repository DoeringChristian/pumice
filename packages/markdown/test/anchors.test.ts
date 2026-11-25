import { describe, expect, it } from 'vitest';
import { extractMetadata } from '../src';

describe('names of places', () => {
  const ids = (text: string) =>
    extractMetadata(text).blocks.map((b) => [b.id, text.slice(b.from, b.to)]);

  it('names the paragraph, list item or heading it ends', () => {
    expect(ids('One. {#one}\n\n- a\n- b {#b}\n\n## Part {#part}\n')).toEqual([
      ['one', 'One. {#one}'],
      ['b', '- b {#b}'],
      ['part', '## Part {#part}'],
    ]);
    expect(extractMetadata('## Part {#part}\n').headings[0]!.text).toBe('Part');
  });

  it('still reads `^id`', () => {
    expect(ids('One. ^one\n')).toEqual([['one', 'One. ^one']]);
  });

  it('on a line of its own names what stands before it', () => {
    expect(ids('> quote\n\n{#q}\n')).toEqual([['q', '> quote']]);
  });

  it('is text anywhere else', () => {
    expect(ids('a {#b} c\n\nx{#y}\n\n`{#c}`\n\n{# d}\n\n{#if a}\n')).toEqual([]);
  });
});
