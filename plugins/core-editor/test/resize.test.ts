import {
  embedSizeCss,
  parseEmbedSize,
  parseImageAttributes,
  setEmbedSize,
  withAliasSize,
  withoutImageSize,
} from '@pumice/api';
import { describe, expect, it } from 'vitest';
import { blockSizeEdit, embedAt, embedSizeEdit, sameHeightWidths, snapWidth } from '../src/resize';

describe('embed sizes', () => {
  it('writes Obsidian size specifiers', () => {
    expect(setEmbedSize('pic.png', { width: 300 })).toBe('pic.png|300');
    expect(setEmbedSize('pic.png|120', { width: 300.4 })).toBe('pic.png|300');
    expect(setEmbedSize('pic.png|120x80', { width: 300 })).toBe('pic.png|300');
    expect(setEmbedSize('a/b.html#x=1|600', { width: 640, height: 400 })).toBe(
      'a/b.html#x=1|640x400',
    );
    // A caption stays; in a table the bar is escaped.
    expect(setEmbedSize('pic.png|Figure 1', { width: 300 })).toBe('pic.png|Figure 1|300');
    expect(setEmbedSize('pic.png\\|120', { width: 300 })).toBe('pic.png\\|300');
  });

  it('reads them back, also after a caption', () => {
    expect(parseEmbedSize('300')).toMatchObject({ width: 300 });
    expect(parseEmbedSize('640x400')).toMatchObject({ width: 640, height: 400 });
    expect(parseEmbedSize('Figure 1|300')).toMatchObject({ width: 300 });
    expect(parseEmbedSize('Figure 1')).toEqual({});
  });

  it('reads sizes with units', () => {
    expect(parseEmbedSize('50%')).toEqual({ w: { value: 50, unit: '%' } });
    expect(parseEmbedSize('Fig|20em')).toEqual({ w: { value: 20, unit: 'em' } });
    expect(parseEmbedSize('30vwx40vh')).toEqual({
      w: { value: 30, unit: 'vw' },
      h: { value: 40, unit: 'vh' },
    });
    expect(parseEmbedSize('x200').height).toBe(200);
    expect(parseEmbedSize('2.5rem').w).toEqual({ value: 2.5, unit: 'rem' });
    // Not sizes: they stay captions.
    expect(parseEmbedSize('x')).toEqual({});
    expect(parseEmbedSize('50 percent')).toEqual({});
    expect(setEmbedSize('pic.png|Fig|50%', { width: 348 })).toBe('pic.png|Fig|348');
  });

  it('turns a size into CSS: a plain number is a share of the text width', () => {
    expect(embedSizeCss(parseEmbedSize('700')).width).toBe('calc(var(--pm-text-w, 100%) * 1)');
    expect(embedSizeCss(parseEmbedSize('350')).width).toBe('calc(var(--pm-text-w, 100%) * 0.5)');
    expect(embedSizeCss(parseEmbedSize('50%'))).toEqual({ width: '50%' });
    expect(embedSizeCss(parseEmbedSize('300px'))).toEqual({ width: '300px' });
    // Both plain: the proportions. A height with a unit, or alone: that height.
    expect(embedSizeCss(parseEmbedSize('300x200'))).toEqual({
      width: 'calc(var(--pm-text-w, 100%) * 0.42857)',
      aspectRatio: '300 / 200',
    });
    expect(embedSizeCss(parseEmbedSize('50%x10em'))).toEqual({ width: '50%', height: '10em' });
    expect(embedSizeCss(parseEmbedSize('x200'))).toEqual({ height: '200px' });
    expect(embedSizeCss({})).toEqual({});
  });

  it('reads the attributes pandoc writes after an image', () => {
    expect(parseImageAttributes('{width=50%} and text')).toEqual({ length: 11, size: '50%' });
    expect(parseImageAttributes('{ width=300 height=200 }')).toEqual({
      length: 24,
      size: '300x200',
    });
    expect(parseImageAttributes('{#fig:a .wide height="3cm"}')?.size).toBe('x3cm');
    expect(parseImageAttributes('{width=2inch}')?.size).toBe('2in');
    expect(parseImageAttributes('{.wide}')).toEqual({ length: 7 });
    expect(parseImageAttributes('{}')).toBeUndefined();
    expect(parseImageAttributes('{just text}')).toBeUndefined();
    expect(parseImageAttributes(' {width=50%}')).toBeUndefined();
    expect(withAliasSize('Fig 1|300', '50%')).toBe('Fig 1|50%');
    expect(withAliasSize(undefined, '50%')).toBe('50%');
    expect(withoutImageSize('{width=50% .wide height=3cm}')).toBe('{.wide}');
    expect(withoutImageSize('{width=50%}')).toBe('');
  });

  it('changes the embed the handle belongs to', () => {
    const line = 'A ![[a.png]] and ![[b.png|50]] here';
    const edit = (offset: number) => {
      const e = embedSizeEdit(line, offset, { width: 200 }, setEmbedSize)!;
      return line.slice(0, e.from) + e.insert + line.slice(e.to);
    };
    expect(edit(2)).toBe('A ![[a.png|200]] and ![[b.png|50]] here');
    expect(edit(17)).toBe('A ![[a.png]] and ![[b.png|200]] here');
    expect(embedSizeEdit('no embed', 0, { width: 200 }, setEmbedSize)).toBeNull();
    expect(embedSizeEdit('![[a.png|200]]', 0, { width: 200 }, setEmbedSize)).toBeNull();
  });

  it('sets width and height in a frame block', () => {
    const block = '```frame\nfile: [[frames/a/index.html]]\nheight: 200\ntitle: x\n```';
    expect(blockSizeEdit(block, { width: 500, height: 320 })).toBe(
      '```frame\nfile: [[frames/a/index.html]]\nheight: 320\ntitle: x\nwidth: 500\n```',
    );
    expect(blockSizeEdit('```frame\nfile: a\n```\n', { width: 500 })).toBe(
      '```frame\nfile: a\nwidth: 500\n```\n',
    );
    expect(blockSizeEdit('not a block', { width: 1 })).toBe('not a block');
  });

  it('snaps a dragged width to simple fractions of the line', () => {
    expect(snapWidth(352, 700)).toEqual({ name: '1/2', width: 350 });
    expect(snapWidth(180, 700)).toEqual({ name: '1/4', width: 175 });
    expect(snapWidth(240, 700)?.name).toBe('1/3');
    expect(snapWidth(695, 700)?.name).toBe('full');
    expect(snapWidth(290, 700)).toBeUndefined();
  });

  it('finds the embed to remove, with a space beside it', () => {
    const line = 'See ![[a.png|300]] and ![[dir/b.png#x]] here';
    const cut = (offset: number) => {
      const e = embedAt(line, offset)!;
      return [line.slice(0, e.from) + line.slice(e.to), e.target];
    };
    expect(cut(4)).toEqual(['See and ![[dir/b.png#x]] here', 'a.png']);
    expect(cut(23)).toEqual(['See ![[a.png|300]] and here', 'dir/b.png']);
    expect(embedAt('![[a.png]]', 0)).toEqual({ from: 0, to: 10, target: 'a.png' });
    expect(embedAt('nothing', 0)).toBeNull();
  });
});

describe('the caption of a frame block', () => {
  it('is written after the file, replaced, or removed', async () => {
    const { blockCaptionEdit } = await import('../src/resize');
    const block = '```frame\nfile: frames/bars/index.html\nwidth: 300\n```';
    const captioned = blockCaptionEdit(block, 'Sales: 2024 #1');
    expect(captioned).toBe(
      '```frame\nfile: frames/bars/index.html\ncaption: "Sales: 2024 #1"\nwidth: 300\n```',
    );
    expect(blockCaptionEdit(captioned, 'Other')).toBe(
      '```frame\nfile: frames/bars/index.html\ncaption: "Other"\nwidth: 300\n```',
    );
    expect(blockCaptionEdit(captioned, ' ')).toBe(block);
    expect(blockCaptionEdit(block, '')).toBe(block);
  });
});

describe('the width at which a picture of a row is as high as another', () => {
  // How high each is drawn: the room it has, less its part of the gaps, by its proportions.
  const heights = (
    max: number,
    w: number,
    aspect: number,
    others: { share: number; aspect: number }[],
  ) => {
    const c = 12 - 12 / (others.length + 1);
    const total = others.reduce((s, o) => s + o.share, 0);
    return [(w - c) / aspect, ...others.map((o) => (((max - w) * o.share) / total - c) / o.aspect)];
  };
  it('is half the line for two of the same proportions', () => {
    expect(sameHeightWidths(700, 1.5, [{ share: 1, aspect: 1.5 }])[0]).toBeCloseTo(350);
  });
  it('gives the wider picture more room', () => {
    const others = [{ share: 300, aspect: 16 / 9 }];
    const [w] = sameHeightWidths(700, 4 / 3, others);
    expect(w).toBeLessThan(350);
    const [mine, other] = heights(700, w!, 4 / 3, others);
    expect(mine).toBeCloseTo(other!);
  });
  it('finds one for each of the others, and none for what has no proportions', () => {
    const others = [{ share: 200, aspect: 1 }, { share: 300, aspect: 2 }, { share: 100 }];
    const found = sameHeightWidths(700, 1.5, others);
    expect(found).toHaveLength(2);
    const full = others.map((o) => ({ share: o.share, aspect: o.aspect ?? 1 }));
    expect(heights(700, found[0]!, 1.5, full)[0]).toBeCloseTo(
      heights(700, found[0]!, 1.5, full)[1]!,
    );
    expect(heights(700, found[1]!, 1.5, full)[0]).toBeCloseTo(
      heights(700, found[1]!, 1.5, full)[2]!,
    );
  });
});
