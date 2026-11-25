/**
 * How large a picture or video is, from the beginning of its file: without reading the rest of
 * it. Undefined for what is not understood; it is learned when it is shown, then.
 */
export interface Size {
  width: number;
  height: number;
}
/** A part of the file (shorter at its end). Undefined: parts of files cannot be read here. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array | undefined>;

const CHUNK = 16 * 1024;
/** More hops than any sound file needs: one that leads in circles comes to an end. */
const HOPS = 400;

class NotReadable extends Error {}

/** Reads numbers anywhere in the file, fetching a piece at a time. */
class Source {
  private chunk: DataView | undefined;
  private at = 0;
  private hops = 0;

  constructor(private readonly read: ReadRange) {}

  async view(offset: number, length: number): Promise<DataView> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new NotReadable();
    const there =
      this.chunk && offset >= this.at && offset + length <= this.at + this.chunk.byteLength;
    if (!there) {
      if (++this.hops > HOPS) throw new NotReadable();
      const bytes = await this.read(offset, Math.max(length, CHUNK));
      if (!bytes || bytes.byteLength < length) throw new NotReadable();
      this.chunk = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.at = offset;
    }
    return new DataView(this.chunk!.buffer, this.chunk!.byteOffset + offset - this.at, length);
  }
  async u8(o: number) {
    return (await this.view(o, 1)).getUint8(0);
  }
  async u16(o: number, little = false) {
    return (await this.view(o, 2)).getUint16(0, little);
  }
  async u32(o: number, little = false) {
    return (await this.view(o, 4)).getUint32(0, little);
  }
  async ascii(o: number, length: number) {
    const v = await this.view(o, length);
    return String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, length));
  }
}

async function png(s: Source): Promise<Size | undefined> {
  if ((await s.u32(0)) !== 0x89504e47 || (await s.ascii(12, 4)) !== 'IHDR') return undefined;
  return { width: await s.u32(16), height: await s.u32(20) };
}

async function gif(s: Source): Promise<Size | undefined> {
  if ((await s.ascii(0, 3)) !== 'GIF') return undefined;
  return { width: await s.u16(6, true), height: await s.u16(8, true) };
}

async function bmp(s: Source): Promise<Size | undefined> {
  if ((await s.ascii(0, 2)) !== 'BM' || (await s.u32(14, true)) < 40) return undefined;
  // Stored from the top, its height is negative.
  return { width: await s.u32(18, true), height: Math.abs((await s.u32(22, true)) | 0) };
}

async function webp(s: Source): Promise<Size | undefined> {
  if ((await s.ascii(0, 4)) !== 'RIFF' || (await s.ascii(8, 4)) !== 'WEBP') return undefined;
  const kind = await s.ascii(12, 4);
  if (kind === 'VP8 ')
    return {
      width: (await s.u16(26, true)) & 0x3fff,
      height: (await s.u16(28, true)) & 0x3fff,
    };
  if (kind === 'VP8L') {
    const bits = await s.u32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind !== 'VP8X') return undefined;
  const u24 = async (o: number) => (await s.u16(o, true)) | ((await s.u8(o + 2)) << 16);
  return { width: (await u24(24)) + 1, height: (await u24(27)) + 1 };
}

/** Whether the EXIF data at `at` (behind `Exif\0\0`) turns the picture on its side. */
async function turned(s: Source, at: number): Promise<boolean> {
  const little = (await s.ascii(at, 2)) === 'II';
  const directory = at + (await s.u32(at + 4, little));
  const count = Math.min(200, await s.u16(directory, little));
  for (let i = 0; i < count; i++) {
    const entry = directory + 2 + i * 12;
    if ((await s.u16(entry, little)) === 0x0112) return (await s.u16(entry + 8, little)) >= 5;
  }
  return false;
}

async function jpeg(s: Source): Promise<Size | undefined> {
  if ((await s.u16(0)) !== 0xffd8) return undefined;
  let side = false;
  for (let at = 2; ;) {
    if ((await s.u8(at)) !== 0xff) return undefined;
    const marker = await s.u8(at + 1);
    if (marker === 0xff) {
      at++;
      continue;
    }
    // The frame header (not a table, which have numbers among them).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = await s.u16(at + 5);
      const width = await s.u16(at + 7);
      return side ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = await s.u16(at + 2);
    if (length < 2) return undefined;
    if (marker === 0xe1 && length > 16 && (await s.ascii(at + 4, 4)) === 'Exif')
      // EXIF data that is broken says nothing about the picture.
      side = await turned(s, at + 10).catch(() => false);
    at += 2 + length;
  }
}

async function svg(read: ReadRange): Promise<Size | undefined> {
  const bytes = await read(0, 8 * 1024);
  if (!bytes) return undefined;
  const tag = /<svg\b[^>]*>/i.exec(new TextDecoder().decode(bytes))?.[0];
  if (!tag) return undefined;
  // Only a size in pixels: without one it is as large as where it stands lets it be.
  const side = (name: string) =>
    Number(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`).exec(tag)?.[1]);
  const width = side('width');
  const height = side('height');
  return width && height ? { width: Math.round(width), height: Math.round(height) } : undefined;
}

/** The boxes of an MP4 file between two places: what they are, and where their content is. */
async function* boxes(s: Source, from: number, to: number) {
  for (let at = from; at + 8 <= to;) {
    let size = await s.u32(at);
    const type = await s.ascii(at + 4, 4);
    let head = 8;
    if (size === 1) {
      size = (await s.u32(at + 8)) * 2 ** 32 + (await s.u32(at + 12));
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head) return;
    yield { type, start: at + head, end: Math.min(to, at + size) };
    at += size;
  }
}

async function mp4(s: Source): Promise<Size | undefined> {
  if ((await s.ascii(4, 4)) !== 'ftyp') return undefined;
  // (The end of the file is not known: the box is found before it, or reading fails.)
  for await (const box of boxes(s, 0, Number.MAX_SAFE_INTEGER)) {
    if (box.type !== 'moov') continue;
    for await (const track of boxes(s, box.start, box.end)) {
      if (track.type !== 'trak') continue;
      for await (const head of boxes(s, track.start, track.end)) {
        if (head.type !== 'tkhd') continue;
        const base = head.start + ((await s.u8(head.start)) === 1 ? 52 : 40);
        const width = Math.round((await s.u32(base + 36)) / 65536);
        const height = Math.round((await s.u32(base + 40)) / 65536);
        // (A sound track has no size.)
        if (!width || !height) continue;
        const side = (await s.u32(base)) === 0 && (await s.u32(base + 4)) !== 0;
        return side ? { width: height, height: width } : { width, height };
      }
    }
    return undefined;
  }
  return undefined;
}

/** WebM and Matroska: elements in elements, each with an id and a length of variable size. */
async function webm(s: Source): Promise<Size | undefined> {
  if ((await s.u32(0)) !== 0x1a45dfa3) return undefined;
  const element = async (at: number) => {
    const first = await s.u8(at);
    const idLength = Math.clz32(first) - 23;
    if (idLength > 4) throw new NotReadable();
    let id = 0;
    for (let i = 0; i < idLength; i++) id = id * 256 + (await s.u8(at + i));
    const lead = await s.u8(at + idLength);
    const lengthLength = Math.clz32(lead) - 23;
    if (lengthLength > 8) throw new NotReadable();
    let length = lead & (0xff >> lengthLength);
    let open = length === 0xff >> lengthLength;
    for (let i = 1; i < lengthLength; i++) {
      const byte = await s.u8(at + idLength + i);
      open &&= byte === 0xff;
      length = length * 256 + byte;
    }
    const start = at + idLength + lengthLength;
    // Written as it was recorded: its length is not known.
    return { id, start, end: open ? Number.MAX_SAFE_INTEGER : start + length };
  };
  const find = async (from: number, to: number, ids: number[]) => {
    const found = new Map<number, { start: number; end: number }>();
    for (let at = from; at < to;) {
      const e = await element(at);
      if (ids.includes(e.id)) found.set(e.id, e);
      // A cluster: the pictures begin, and what describes them is behind us.
      if (found.size === ids.length || e.id === 0x1f43b675 || e.end <= at) break;
      at = e.end;
    }
    return found;
  };
  const number = async (e: { start: number; end: number } | undefined) => {
    let value = 0;
    if (e)
      for (let at = e.start; at < Math.min(e.end, e.start + 6); at++)
        value = value * 256 + (await s.u8(at));
    return value;
  };
  const segment = (await find(0, Number.MAX_SAFE_INTEGER, [0x18538067])).get(0x18538067);
  if (!segment) return undefined;
  const tracks = (await find(segment.start, segment.end, [0x1654ae6b])).get(0x1654ae6b);
  if (!tracks) return undefined;
  for (let at = tracks.start; at < tracks.end;) {
    const track = await element(at);
    const video =
      track.id === 0xae ? (await find(track.start, track.end, [0xe0])).get(0xe0) : undefined;
    if (video) {
      const parts = await find(video.start, video.end, [0xb0, 0xba, 0x54b0, 0x54ba, 0x54b2]);
      // Shown in other proportions than it is stored (in pixels, unless it says otherwise).
      const unit = await number(parts.get(0x54b2));
      const width = (!unit && (await number(parts.get(0x54b0)))) || (await number(parts.get(0xb0)));
      const height =
        (!unit && (await number(parts.get(0x54ba)))) || (await number(parts.get(0xba)));
      return { width, height };
    }
    if (track.end <= at) break;
    at = track.end;
  }
  return undefined;
}

const FORMATS: Record<string, (s: Source) => Promise<Size | undefined>> = {
  png,
  gif,
  bmp,
  webp,
  jpg: jpeg,
  jpeg,
  mp4,
  m4v: mp4,
  mov: mp4,
  webm,
  mkv: webm,
};

/** The size a file of this type says it has, if it can be told from its beginning. */
export async function mediaSize(extension: string, read: ReadRange): Promise<Size | undefined> {
  const ext = extension.toLowerCase();
  try {
    const size = ext === 'svg' ? await svg(read) : await FORMATS[ext]?.(new Source(read));
    return size && size.width > 0 && size.height > 0 && size.width < 1e5 && size.height < 1e5
      ? size
      : undefined;
  } catch {
    return undefined;
  }
}

/** An empty picture of this size: laid out as the real one will be, whatever sizes it. */
export function placeholder({ width, height }: Size): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`,
  )}`;
}
