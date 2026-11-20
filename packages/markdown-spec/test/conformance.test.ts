import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  dialectLezerParser,
  parseMarkdown,
  semanticFromLezer,
  semanticFromMdast,
  type SemanticNode,
} from '@pumice/markdown';

const dir = join(import.meta.dirname, '..', 'corpus');
const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3));

/** Replaces offsets by the source text they cover, which is what fixtures record. */
function readable(nodes: SemanticNode[], text: string) {
  return nodes.map(({ from, to, ...rest }) => ({ ...rest, text: text.slice(from, to) }));
}

describe('markdown conformance', () => {
  for (const name of cases) {
    const text = readFileSync(join(dir, `${name}.md`), 'utf8');
    const expected = (
      JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as {
        nodes: Array<Record<string, unknown>>;
      }
    ).nodes.map(({ text: t, kind, ...rest }) => ({ kind, ...rest, text: t }));

    test(`${name}: micromark`, () => {
      expect(readable(semanticFromMdast(parseMarkdown(text)), text)).toEqual(expected);
    });

    test(`${name}: lezer`, () => {
      const tree = dialectLezerParser().parse(text);
      expect(readable(semanticFromLezer(tree, text), text)).toEqual(expected);
    });
  }
});
