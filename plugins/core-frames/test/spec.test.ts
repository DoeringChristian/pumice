import { describe, expect, it } from 'vitest';
import { FRAME_KIT, withKit } from '../src/kit';
import {
  entryCandidates,
  frameSlug,
  linkTarget,
  mapLinks,
  parseFrameBlock,
  parseFrameQuery,
} from '../src/spec';

describe('parseFrameBlock', () => {
  it('reads the file, the reserved keys and the settings', () => {
    expect(
      parseFrameBlock(
        [
          'file: [[frames/field/index.html]]',
          'caption: Pressure field, run 12',
          'height: 320',
          'data: [[runs/field, final: 12.json]]',
          'colormap: viridis',
          'meshes:',
          '  - label: coarse',
          '    file: [[data/coarse.obj]]',
          'pair: [[[a.png]], [[b.png]]]',
        ].join('\n'),
      ),
    ).toEqual({
      file: 'frames/field/index.html',
      caption: 'Pressure field, run 12',
      height: 320,
      settings: {
        data: '[[runs/field, final: 12.json]]',
        colormap: 'viridis',
        meshes: [{ label: 'coarse', file: '[[data/coarse.obj]]' }],
        pair: ['[[a.png]]', '[[b.png]]'],
      },
    });
  });

  it('accepts a plain path or a name for the file', () => {
    expect(parseFrameBlock('file: frames/a/index.html').file).toBe('frames/a/index.html');
    expect(parseFrameBlock('file: field\nn: 3')).toEqual({ file: 'field', settings: { n: 3 } });
  });

  it('explains what is missing', () => {
    expect(() => parseFrameBlock('caption: x')).toThrow(/file:/);
    expect(() => parseFrameBlock('just text')).toThrow(/file:/);
    expect(() => parseFrameBlock('file: [a')).toThrow(/YAML/);
  });
});

describe('links in settings', () => {
  it('recognizes whole-value links only', () => {
    expect(linkTarget('[[a/b.json]]')).toBe('a/b.json');
    expect(linkTarget('[[b.json|label]]')).toBe('b.json');
    expect(linkTarget('see [[b.json]]')).toBeUndefined();
  });

  it('maps them at any depth', async () => {
    const out = await mapLinks(
      { a: '[[x.json]]', b: ['[[y.png]]', 'text', 3], c: { d: '[[z.csv]]' } },
      async (target) => `url:${target}`,
    );
    expect(out).toEqual({ a: 'url:x.json', b: ['url:y.png', 'text', 3], c: { d: 'url:z.csv' } });
  });
});

describe('parseFrameQuery', () => {
  it('reads settings after the #', () => {
    expect(parseFrameQuery('#color=red&points=20')).toEqual({ color: 'red', points: '20' });
    expect(parseFrameQuery(undefined)).toEqual({});
  });
});

describe('entryCandidates', () => {
  it('finds a frame by path or by name', () => {
    expect(entryCandidates('frames/field/index.html', 'frames')).toEqual([
      'frames/field/index.html',
      'frames/frames/field/index.html',
    ]);
    expect(entryCandidates('field', 'frames')).toEqual([
      'field/index.html',
      'frames/field/index.html',
      'field.html',
      'frames/field.html',
    ]);
  });
});

describe('frameSlug', () => {
  it('makes lowercase names with dashes', () => {
    expect(frameSlug('  Pressure Field (v2) ')).toBe('pressure-field-v2');
  });
});

describe('withKit', () => {
  it('goes first in the head, or first in the file', () => {
    expect(withKit('<html><head><title>x</title></head></html>', 'KIT')).toBe(
      '<html><head>KIT<title>x</title></head></html>',
    );
    expect(withKit('<!doctype html>\n<p>x</p>', 'KIT')).toBe('<!doctype html>KIT\n<p>x</p>');
    expect(withKit('<p>x</p>', 'KIT')).toBe('KIT<p>x</p>');
  });

  it('is valid script and cannot end the script element early', () => {
    const script = /<script data-pumice>([\s\S]*)<\/script>$/.exec(FRAME_KIT)![1]!;
    expect(script).not.toContain('</script');
    expect(() => new Function(script)).not.toThrow();
  });
});
