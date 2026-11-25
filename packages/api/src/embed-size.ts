import { embedSizeProperties, type EmbedSize } from '@pumice/markdown';

/**
 * Gives the box of an embed the size its text says (`|300`, `|50%`, `|300x200`). The box alone
 * has a size, and what it shows fills it (the `pm-embed-media` element in it, see the reader's
 * style sheet): whatever is embedded is sized the same way, and none of it needs to know how.
 */
export function sizeEmbed(box: HTMLElement, size: EmbedSize): void {
  const properties = embedSizeProperties(size);
  box.classList.toggle('is-sized', !!properties['--embed-w']);
  for (const [name, value] of Object.entries(properties))
    if (value) box.style.setProperty(name, value);
    else box.style.removeProperty(name);
}
