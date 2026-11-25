import { describe, expect, it } from 'vitest';
import { localLinks, offsetOf, parsePlace, placesIn } from '../src/references';

describe('places an agent refers to', () => {
  it('reads paths, lines and headings', () => {
    expect(parsePlace('Projects/Plan.md')).toEqual({ path: 'Projects/Plan.md' });
    expect(parsePlace('Plan.md:12')).toEqual({ path: 'Plan.md', line: 12 });
    expect(parsePlace('Plan.md:12:8-14:2')).toEqual({ path: 'Plan.md', line: 12, column: 8 });
    expect(parsePlace('Plan.md:12-14')).toEqual({ path: 'Plan.md', line: 12 });
    expect(parsePlace('Plan.md#L12-L14')).toEqual({ path: 'Plan.md', line: 12 });
    expect(parsePlace('Plan#Next steps')).toEqual({ path: 'Plan', subpath: 'Next steps' });
    expect(parsePlace('file:///v/Plan.md')).toEqual({ path: '/v/Plan.md' });
  });

  it('finds them in text', () => {
    const found = (t: string) => placesIn(t).map((p) => t.slice(p.from, p.to));
    expect(found('See Projects/Plan.md:12, then (a.md) and b.md.')).toEqual([
      'Projects/Plan.md:12',
      'a.md',
      'b.md',
    ]);
    expect(found('It is in "My notes/The plan.md:3:4".')).toEqual(['My notes/The plan.md:3:4']);
    expect(found('At /Users/x/vault/a.md now')).toEqual(['/Users/x/vault/a.md']);
    expect(found('https://example.org/a.md and me@example.org')).toEqual([]);
  });

  it('finds a line', () => {
    expect(offsetOf('ab\ncd\nef', 2)).toBe(3);
    expect(offsetOf('ab\ncd\nef', 2, 2)).toBe(4);
    expect(offsetOf('ab\ncd\nef', 2, 99)).toBe(5);
    expect(offsetOf('ab\ncd', 99)).toBe(3);
  });

  it('keeps links to files apart from those to the web', () => {
    const link = (url: string) => {
      const n = { type: 'root', children: [{ type: 'link', url }] };
      localLinks(n);
      return n.children[0]!.url;
    };
    expect(link('Plan.md:12')).toBe('./Plan.md:12');
    expect(link('file:///v/Plan.md')).toBe('/v/Plan.md');
    expect(link('https://example.org:80')).toBe('https://example.org:80');
  });
});
