/**
 * Copying a picture of the vault itself (not only the text that shows it), so it pastes into
 * other programs as a picture. With `text` (how a note shows it) the clipboard has both: a note
 * of this vault pastes the text, another program the picture.
 */

const TYPES: Record<string, string> = {
  png: 'image/png',
  apng: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

const typeOf = (path: string) => TYPES[path.split('.').pop()?.toLowerCase() ?? ''];

/** Whether the file is a picture that can be copied as one. */
export const isPicture = (path: string): boolean => !!typeOf(path);

/** The picture as a PNG: what clipboards take (others are drawn anew). */
async function asPng(bytes: Uint8Array, path: string): Promise<Blob> {
  const type = typeOf(path)!;
  const blob = new Blob([bytes as BlobPart], { type });
  if (type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // (A drawing without a size of its own gets one.)
    const width = img.naturalWidth || 1200;
    const height = img.naturalHeight || Math.round(width * 0.75);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture.'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Puts the picture at `path` on the clipboard (as a PNG), with `text` beside it. The clipboard is
 * asked for at once, while the click that asked for it still counts: the picture follows.
 */
export function copyPicture(
  path: string,
  read: () => Promise<Uint8Array>,
  text?: string,
): Promise<void> {
  const png = read().then((bytes) => asPng(bytes, path));
  return navigator.clipboard.write([
    new ClipboardItem({
      'image/png': png,
      ...(text ? { 'text/plain': new Blob([text], { type: 'text/plain' }) } : {}),
    }),
  ]);
}
