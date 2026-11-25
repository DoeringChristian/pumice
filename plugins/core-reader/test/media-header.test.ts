import { describe, expect, it } from 'vitest';
import { mediaSize } from '../src/media-header';

const reader = (data: Uint8Array) => {
  let bytes = 0;
  return {
    read: async (o: number, n: number) => {
      const part = data.subarray(o, o + n);
      bytes += part.length;
      return part;
    },
    get bytes() {
      return bytes;
    },
  };
};
const size = (ext: string, data: Uint8Array) => mediaSize(ext, reader(data).read);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be = (n: number, length: number) =>
  Array.from({ length }, (_, i) => Math.floor(n / 256 ** (length - 1 - i)) & 255);
const le = (n: number, length: number) => be(n, length).reverse();
const box = (type: string, ...content: number[][]) => {
  const inner = content.flat();
  return [...be(inner.length + 8, 4), ...ascii(type), ...inner];
};
const u8 = (...parts: number[][]) => new Uint8Array(parts.flat());

const jpeg = (orientation?: number, padding = 0) => {
  const exif = [
    ...ascii('Exif'),
    0,
    0,
    ...ascii('II'),
    42,
    0,
    ...le(8, 4),
    ...le(1, 2),
    ...le(0x0112, 2),
    ...le(3, 2),
    ...le(1, 4),
    ...le(orientation ?? 1, 2),
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  return u8(
    [0xff, 0xd8],
    orientation ? [0xff, 0xe1, ...be(exif.length + 2, 2), ...exif] : [],
    padding ? [0xff, 0xe2, ...be(padding + 2, 2), ...Array<number>(padding).fill(1)] : [],
    // A table, which is not the frame header.
    [0xff, 0xc4, 0, 4, 9, 9],
    [0xff, 0xc2, 0, 11, 8, ...be(480, 2), ...be(640, 2), 1, 1, 1, 0],
  );
};
const tkhd = (w: number, h: number, side = false) =>
  box(
    'tkhd',
    [0, 0, 0, 0],
    Array<number>(36).fill(0),
    side ? [...be(0, 4), ...be(0x10000, 4)] : [...be(0x10000, 4), ...be(0, 4)],
    Array<number>(28).fill(0),
    be(w * 65536, 4),
    be(h * 65536, 4),
  );
const el = (id: number[], ...content: number[][]) => {
  const inner = content.flat();
  return [...id, 0x40 | (inner.length >> 8), inner.length & 255, ...inner];
};

describe('the size of a file from its beginning', () => {
  it('reads pictures', async () => {
    expect(
      await size(
        'png',
        u8(
          [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10],
          be(13, 4),
          ascii('IHDR'),
          be(800, 4),
          be(600, 4),
        ),
      ),
    ).toEqual({ width: 800, height: 600 });
    expect(await size('GIF', u8(ascii('GIF89a'), le(30, 2), le(20, 2)))).toEqual({
      width: 30,
      height: 20,
    });
    expect(
      await size(
        'bmp',
        u8(ascii('BM'), Array<number>(12).fill(0), le(40, 4), le(64, 4), le(2 ** 32 - 48, 4)),
      ),
    ).toEqual({ width: 64, height: 48 });
    expect(
      await size(
        'webp',
        u8(ascii('RIFF'), be(0, 4), ascii('WEBPVP8X'), be(0, 8), le(1919, 3), le(1079, 3)),
      ),
    ).toEqual({ width: 1920, height: 1080 });
  });

  it('reads photos, also those on their side and behind a large profile', async () => {
    expect(await size('jpg', jpeg())).toEqual({ width: 640, height: 480 });
    expect(await size('jpeg', jpeg(6))).toEqual({ width: 480, height: 640 });
    expect(await size('jpg', jpeg(3, 60_000))).toEqual({ width: 640, height: 480 });
  });

  it('reads drawings that say how large they are', async () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(
      await size('svg', text('<?xml?><svg viewBox="0 0 9 9" width="120px" height="80">')),
    ).toEqual({ width: 120, height: 80 });
    expect(await size('svg', text('<svg viewBox="0 0 9 9">'))).toBeUndefined();
    expect(await size('svg', text('<svg width="100%" height="50%">'))).toBeUndefined();
  });

  it('reads videos, with what describes them at the end too, without reading the rest', async () => {
    const moov = box('moov', box('trak', tkhd(0, 0)), box('trak', tkhd(1280, 720)));
    expect(await size('mp4', u8(box('ftyp', ascii('isom')), moov))).toEqual({
      width: 1280,
      height: 720,
    });
    const late = u8(box('ftyp', ascii('isom')), box('mdat', Array<number>(300_000).fill(0)), moov);
    const r = reader(late);
    expect(await mediaSize('mov', r.read)).toEqual({ width: 1280, height: 720 });
    expect(r.bytes).toBeLessThan(40_000);
    expect(
      await size(
        'mp4',
        u8(box('ftyp', ascii('isom')), box('moov', box('trak', tkhd(1280, 720, true)))),
      ),
    ).toEqual({ width: 720, height: 1280 });
  });

  it('reads recordings of unknown length', async () => {
    const video = el([0xe0], el([0xb0], be(640, 2)), el([0xba], be(360, 2)));
    const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0xd7], [1])), el([0xae], video));
    const file = u8(
      el([0x1a, 0x45, 0xdf, 0xa3], [1, 2]),
      [0x18, 0x53, 0x80, 0x67, 0x01, ...Array<number>(7).fill(0xff)],
      tracks,
      [0x1f, 0x43, 0xb6, 0x75, 0x81, 0],
    );
    expect(await size('webm', file)).toEqual({ width: 640, height: 360 });
  });

  it('gives up on what it does not understand, and where parts cannot be read', async () => {
    expect(await size('png', u8([1, 2, 3]))).toBeUndefined();
    expect(await size('jpg', new Uint8Array(100))).toBeUndefined();
    expect(await size('mp4', u8(box('ftyp', ascii('isom')), box('free')))).toBeUndefined();
    expect(
      await size('webm', u8([0x1a, 0x45, 0xdf, 0xa3], Array<number>(50).fill(0))),
    ).toBeUndefined();
    expect(await size('avif', new Uint8Array(100))).toBeUndefined();
    expect(await mediaSize('png', async () => undefined)).toBeUndefined();
    // Boxes that lead nowhere forward.
    expect(
      await size(
        'mp4',
        u8(box('ftyp', ascii('isom')), [0, 0, 0, 1, ...ascii('free'), ...be(0, 8)]),
      ),
    ).toBeUndefined();
  });
});
