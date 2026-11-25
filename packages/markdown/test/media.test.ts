import { describe, expect, it } from 'vitest';
import { numberItems, referableItems } from '../src/figures';
import {
  mediaAt,
  mediaCaptionChange,
  mediaIn,
  mediaSizeChanges,
  type LineChange,
} from '../src/media';

const apply = (line: string, changes: LineChange[]) =>
  [...changes]
    .sort((a, b) => b.from - a.from)
    .reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), line);
const sized = (line: string, width: number, height?: number) =>
  apply(line, mediaSizeChanges(line, mediaIn(line)[0]!, { width, ...(height ? { height } : {}) }));
const captioned = (line: string, text: string) =>
  apply(line, [mediaCaptionChange(line, mediaIn(line)[0]!, text)]);

describe('media in a line', () => {
  it('is the same in both spellings', () => {
    for (const line of [
      '![[a.png|A plot]]{#fig-a width=50%}',
      '![A plot](a.png){#fig-a width=50%}',
      '![A plot](<a.png> "title"){#fig-a width=50%}',
    ]) {
      const [m] = mediaIn(line);
      expect(m).toMatchObject({ target: 'a.png', caption: 'A plot', id: 'fig-a' });
      expect(m!.size.w).toEqual({ value: 50, unit: '%' });
      expect(m!.to).toBe(line.length);
    }
  });
  it('is found in order, on the web too, and not in code', () => {
    const line =
      '`![[no.png]]` ![W](https://x.org/a_(1).png?b=1#c) and ![[https://x.org/p#q]]![[n#Part|x]]';
    expect(mediaIn(line).map((m) => [m.target, m.subpath])).toEqual([
      ['https://x.org/a_(1).png?b=1#c', undefined],
      ['https://x.org/p#q', undefined],
      ['n', 'Part'],
    ]);
    expect(mediaAt(line, line.indexOf('![[n#'))?.target).toBe('n');
    expect(mediaAt(line, line.length)).toBeUndefined();
  });
  it('is never mistaken for its neighbour', () => {
    const line = '![plot [detail] \\] x](a.png) ![[b.png]]';
    expect(mediaIn(line).map((m) => m.target)).toEqual(['a.png', 'b.png']);
    expect(mediaAt(line, 0)?.target).toBe('a.png');
    // What cannot be read is nothing, not the next one.
    expect(mediaAt('![a](b c.png) ![[d.png]]', 0)).toBeUndefined();
  });
  it('reads sizes as Obsidian writes them', () => {
    expect(mediaIn('![[a.png|Cap|300x200]]')[0]).toMatchObject({
      caption: 'Cap',
      size: { width: 300, height: 200 },
    });
    expect(mediaIn('![Cap|300](a.png)')[0]).toMatchObject({ caption: 'Cap', size: { width: 300 } });
    expect(mediaIn('![[a.png|300]]')[0]!.caption).toBeUndefined();
  });
});

describe('writing a size', () => {
  it('uses attributes, in both spellings', () => {
    expect(sized('![[a.png]]', 350)).toBe('![[a.png]]{width=50%}');
    expect(sized('![A](a.png) text', 233.33)).toBe('![A](a.png){width=33.3%} text');
    expect(sized('![[f.html]]', 350, 240.4)).toBe('![[f.html]]{width=50% height=240px}');
  });
  it('replaces a size that is there, however it is written', () => {
    expect(sized('![[a.png|300]]', 350)).toBe('![[a.png]]{width=50%}');
    expect(sized('![[a.png|Cap|300x200]]{#fig-a}', 350)).toBe('![[a.png|Cap]]{#fig-a width=50%}');
    expect(sized('![Cap|300](a.png)', 350)).toBe('![Cap](a.png){width=50%}');
    expect(sized('![300](a.png)', 350)).toBe('![](a.png){width=50%}');
    expect(sized('![[a.png]]{.x width="10em" height=3cm}', 350)).toBe('![[a.png]]{.x width=50%}');
    expect(sized('| ![[a.png\\|300]] |', 350)).toBe('| ![[a.png]]{width=50%} |');
    const same = '![[a.png]]{width=50%}';
    expect(mediaSizeChanges(same, mediaIn(same)[0]!, { width: 350 })).toEqual([]);
  });
});

describe('writing a caption', () => {
  it('works in both spellings and keeps what else is there', () => {
    expect(captioned('![[a.png]]{#fig-a}', 'New')).toBe('![[a.png|New]]{#fig-a}');
    expect(captioned('![[a.png|Old|300]]', 'New')).toBe('![[a.png|New|300]]');
    expect(captioned('![[a.png#page=2|Old]]', '')).toBe('![[a.png#page=2]]');
    expect(captioned('![[a.png|300]]', 'See [[#^fig-b]] | [x]')).toBe(
      '![[a.png|See [[#^fig-b]] x|300]]',
    );
    expect(captioned('![Old|300](a.png){width=20%}', 'New')).toBe('![New|300](a.png){width=20%}');
    expect(captioned('![Old](a.png)', '')).toBe('![](a.png)');
    expect(captioned('| ![[a.png\\|Old]] |', 'New')).toBe('| ![[a.png\\|New]] |');
  });
});

describe('figures', () => {
  it('are numbered by caption or label, whatever the spelling', () => {
    const text = [
      'An ![](icon.png) and ![[icon.png]] in text.',
      '![One](a.png)',
      '![[b.png|Two]]',
      '![](https://x.org/c?id=3){#fig-c}',
      '![a note](other.md)',
      '`![Code](d.png)`',
      '![Five](e.png){#fig-e width=20%}',
    ].join('\n\n');
    expect(numberItems(text).map((i) => [i.number, i.caption, i.id])).toEqual([
      [1, 'One', undefined],
      [2, 'Two', undefined],
      [3, undefined, 'fig-c'],
      [4, 'Five', 'fig-e'],
    ]);
    // Their places among all pictures, by which a rendered note finds them.
    expect(referableItems(text).map((i) => i.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
