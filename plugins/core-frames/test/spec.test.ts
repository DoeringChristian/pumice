import { frameBlockAt } from '../src/completion';
import { describe, expect, it } from 'vitest';
import { FRAME_KIT, withKit } from '../src/kit';
import { frameBlock, isFrameManifest, opens, parseFrameManifest, viewerAt } from '../src/viewers';
import {
  entryCandidates,
  frameSlug,
  linkTarget,
  blockText,
  frameFence,
  hasRef,
  mapRefs,
  webTarget,
  withSettings,
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
          'width: 500',
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
      width: 500,
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
    const out = await mapRefs(
      {
        a: '[[x.json]]',
        b: ['[[y.png]]', 'text', 3],
        c: {
          d: '[[z.csv]]',
          e: '[Lucy](https://example.org/lucy.ply)',
          f: 'https://example.org/plain',
        },
      },
      async (ref) => `${ref.kind}:${ref.target}`,
    );
    expect(out).toEqual({
      a: 'vault:x.json',
      b: ['vault:y.png', 'text', 3],
      c: {
        d: 'vault:z.csv',
        e: 'web:https://example.org/lucy.ply',
        f: 'https://example.org/plain',
      },
    });
  });

  it('recognizes references to web resources, in a block too', () => {
    expect(webTarget('[Lucy](https://example.org/a.ply)')).toBe('https://example.org/a.ply');
    expect(webTarget('<https://example.org/a.ply>')).toBe('https://example.org/a.ply');
    expect(webTarget('https://example.org/a.ply')).toBeUndefined();
    expect(webTarget('see [Lucy](https://example.org/a.ply)')).toBeUndefined();
    expect(
      parseFrameBlock(
        'file: mesh-viewer\nmesh: [Lucy](https://example.org/a.ply)\nmore:\n  - [[b.ply]]\n  - <https://example.org/c.ply>',
      ).settings,
    ).toEqual({
      mesh: '[Lucy](https://example.org/a.ply)',
      more: ['[[b.ply]]', '<https://example.org/c.ply>'],
    });
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

describe('frame manifests', () => {
  it('reads the file types a frame opens', () => {
    expect(
      parseFrameManifest(
        JSON.stringify({
          name: 'Mesh viewer',
          opens: { extensions: ['.PLY', 'obj', 'obj', 3], setting: 'mesh' },
        }),
        'frames/mesh-viewer/frame.json',
      ),
    ).toEqual({
      entry: 'frames/mesh-viewer/index.html',
      name: 'Mesh viewer',
      extensions: ['ply', 'obj'],
      setting: 'mesh',
      multiple: false,
      settings: {},
    });
    // The short form, with defaults.
    expect(parseFrameManifest('{"extensions":["csv"]}', 'frames/table/frame.json')).toEqual({
      entry: 'frames/table/index.html',
      name: 'table',
      extensions: ['csv'],
      setting: 'data',
      multiple: false,
      settings: {},
    });
  });

  it("never takes one of the block's own keys as the setting", () => {
    expect(
      parseFrameManifest('{"extensions":["csv"],"setting":"file"}', 'frames/t/frame.json')?.setting,
    ).toBe('data');
  });

  it('ignores manifests that open nothing or are broken', () => {
    expect(parseFrameManifest('{"name":"x"}', 'frames/x/frame.json')).toBeUndefined();
    expect(parseFrameManifest('not json', 'frames/x/frame.json')).toBeUndefined();
    expect(parseFrameManifest('{"extensions":["../x"]}', 'frames/x/frame.json')).toBeUndefined();
  });

  it('only looks at manifests of frames in the frames folder', () => {
    expect(isFrameManifest('frames/mesh-viewer/frame.json', 'frames')).toBe(true);
    expect(isFrameManifest('frames/mesh-viewer/lib/frame.json', 'frames')).toBe(false);
    expect(isFrameManifest('other/mesh-viewer/frame.json', 'frames')).toBe(false);
    expect(isFrameManifest('mesh-viewer/frame.json', '')).toBe(true);
  });

  it('writes the block for one file or several', () => {
    const one = parseFrameManifest(
      '{"extensions":["ply"],"setting":"mesh"}',
      'frames/mesh-viewer/frame.json',
    )!;
    expect(frameBlock(one, ['data/lucy.ply'])).toBe(
      '```frame\nfile: [[frames/mesh-viewer/index.html]]\nmesh: [[data/lucy.ply]]\n```',
    );
    const many = parseFrameManifest(
      '{"opens":{"extensions":["png","jpg"],"setting":"images","multiple":true}}',
      'frames/image-compare/frame.json',
    )!;
    expect(many.multiple).toBe(true);
    expect(frameBlock(many, ['a.png', 'b.png'])).toBe(
      '```frame\nfile: [[frames/image-compare/index.html]]\nimages:\n  - [[a.png]]\n  - [[b.png]]\n```',
    );
    // The block parses back to links, which the frame gets as addresses.
    expect(
      parseFrameBlock(frameBlock(many, ['a.png', 'b.png']).split('\n').slice(1, -1).join('\n')),
    ).toEqual({
      file: 'frames/image-compare/index.html',
      settings: { images: ['[[a.png]]', '[[b.png]]'] },
    });
    expect(opens(many, 'x/Photo.PNG')).toBe(true);
    expect(opens(many, 'x/photo.gif')).toBe(false);
    expect(viewerAt([one, many], 'frames/mesh-viewer')).toBe(one);
    expect(viewerAt([one, many], 'frames/image-compare/index.html')).toBe(many);
    expect(viewerAt([one, many], 'frames/other/index.html')).toBeUndefined();
  });
});

describe('changing a block', () => {
  const yaml = [
    'file: [[frames/compare/index.html]]',
    'caption: Two runs # the figure',
    'height: 300',
    'meshes:',
    '  - [[a.ply]]',
    'up: z',
  ].join('\n');

  it("replaces the settings and keeps the block's own keys", () => {
    expect(
      withSettings(yaml, {
        meshes: ['[[a.ply]]', '[[data/b.ply]]', '[B](https://example.org/b.ply)'],
        colormap: 'viridis',
        file: 'ignored',
      }),
    ).toBe(
      [
        'file: [[frames/compare/index.html]]',
        'caption: Two runs # the figure',
        'height: 300',
        'meshes:',
        '  - [[a.ply]]',
        '  - [[data/b.ply]]',
        '  - [B](https://example.org/b.ply)',
        'colormap: viridis',
      ].join('\n'),
    );
  });

  it('reads back what it wrote', () => {
    const settings = { meshes: ['[[a.ply]]', '[[b, c: d.ply]]'], n: 3, on: true, label: 'x: y' };
    expect(parseFrameBlock(withSettings('file: m', settings)).settings).toEqual(settings);
  });

  it('writes a whole block from an embed', () => {
    expect(
      blockText({
        file: 'frames/compare/index.html',
        width: 600,
        height: 400,
        settings: { files: ['[[a.dat]]', '[[b.dat]]'] },
      }),
    ).toBe(
      '```frame\nfile: [[frames/compare/index.html]]\nwidth: 600\nheight: 400\nfiles:\n  - [[a.dat]]\n  - [[b.dat]]\n```',
    );
  });

  it('finds the lines of a frame block', () => {
    const lines = ['text', '```frame', 'file: a', 'n: 1', '```', 'after'];
    expect(frameFence(lines, 1)).toEqual({ first: 2, last: 3 });
    expect(frameFence(lines, 0)).toBeUndefined();
    expect(frameFence(['```mermaid', 'x', '```'], 0)).toBeUndefined();
    expect(frameFence(['```frame', 'file: a'], 0)).toBeUndefined();
  });

  it('spots references in values', () => {
    expect(hasRef({ a: [1, { b: '[[secret.md]]' }] })).toBe(true);
    expect(hasRef({ a: '<https://example.org/x>' })).toBe(true);
    expect(hasRef({ a: 'app://frame.abc/data/a.ply', b: 'plain [[not whole]] text' })).toBe(false);
  });
});

describe('where suggestions apply in a frame block', () => {
  const lines = [
    'text',
    '```frame',
    'file: [[frames/mesh-viewer/index.html]]',
    'meshes:',
    '  - [[a.ply]]',
    '  - ',
    'up: ',
    'ca',
    '```',
    'after',
  ];
  const at = (index: number, column = lines[index]!.length) => frameBlockAt(lines, index, column);

  it('knows the block, its keys and its frame', () => {
    expect(at(7)).toMatchObject({
      start: 1,
      keys: ['file', 'meshes', 'up'],
      file: 'frames/mesh-viewer/index.html',
    });
  });

  it('tells keys, values and list items apart', () => {
    expect(at(7)?.place).toEqual({ kind: 'key', from: 0 });
    expect(frameBlockAt(['```frame', 'a:', '  - x', '  u'], 3, 3)?.place).toEqual({
      kind: 'key',
      from: 2,
    });
    expect(at(6)?.place).toEqual({ kind: 'value', key: 'up', from: 4, bracketed: false });
    expect(at(5)?.place).toEqual({ kind: 'value', key: 'meshes', from: 4, bracketed: false });
    expect(at(2, 6)?.place).toEqual({ kind: 'file', from: 6 });
    expect(frameBlockAt(['```frame', 'mesh: [[da'], 1, 10)?.place).toEqual({
      kind: 'value',
      key: 'mesh',
      from: 8,
      bracketed: true,
    });
  });

  it('is silent outside frame blocks', () => {
    expect(at(0)).toBeUndefined();
    expect(at(9)).toBeUndefined();
    expect(frameBlockAt(['```ts', 'file: '], 1, 6)).toBeUndefined();
  });

  it('reads the settings a frame documents', () => {
    const viewer = parseFrameManifest(
      JSON.stringify({
        opens: { extensions: ['ply'], setting: 'mesh' },
        settings: {
          up: { description: 'Up axis', values: ['y', 'z'], default: 'z' },
          wireframe: 'Edges',
        },
      }),
      'frames/mesh-viewer/frame.json',
    )!;
    expect(viewer.settings).toEqual({
      up: { description: 'Up axis', values: ['y', 'z'], default: 'z' },
      wireframe: { description: 'Edges' },
    });
  });
});
