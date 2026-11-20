import { parseEmbedSize, setEmbedSize } from '@pumice/api';
import { describe, expect, it } from 'vitest';
import { blockSizeEdit, embedAt, embedSizeEdit, snapWidth } from '../src/resize';

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
    expect(parseEmbedSize('300')).toEqual({ width: 300 });
    expect(parseEmbedSize('640x400')).toEqual({ width: 640, height: 400 });
    expect(parseEmbedSize('Figure 1|300')).toEqual({ width: 300 });
    expect(parseEmbedSize('Figure 1')).toEqual({});
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
