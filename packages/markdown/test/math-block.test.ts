import { parser as baseParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { dialectExtensions } from '../src/lezer';

const parser = baseParser.configure(dialectExtensions);

/** The formula blocks of a text as the editor sees them: the source of each. */
function blocks(text: string): string[] {
  const found: string[] = [];
  parser.parse(text).iterate({
    enter(node) {
      if (node.name === 'MathBlock') found.push(text.slice(node.from, node.to));
    },
  });
  return found;
}

describe('formula blocks in the editor', () => {
  it('is a block from its $$ to its closing $$', () => {
    expect(blocks('Text.\n\n$$\nx^2\n$$\n\nMore text.\n')).toEqual(['$$\nx^2\n$$']);
  });

  it('is not a block while it is not closed: the rest of the note stays text', () => {
    expect(blocks('Text.\n\n$$\n\nA later paragraph with $a$ inline.\n\nMore.\n')).toEqual([]);
    expect(blocks('$$x^2\n\nMore text.\n')).toEqual([]);
  });

  it('keeps two blocks apart', () => {
    expect(blocks('$$\na\n$$\n\ntext\n\n$$\nb\n$$\n')).toEqual(['$$\na\n$$', '$$\nb\n$$']);
  });

  it('closes inside a quote', () => {
    expect(blocks('> $$\n> a\n> $$\n')).toEqual(['$$\n> a\n> $$']);
  });
});
