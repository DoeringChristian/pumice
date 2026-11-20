import { parseWikiLinkContent, type FileMetadata, type LinkRef } from '@pumice/api';
import { drawingText, parseDrawing } from './format';

/**
 * Index metadata of a drawing: frontmatter (ID, tags, aliases) from the head, links from text
 * elements and element links, and every element as a block (`[[drawing#^elementId]]`).
 */
export function drawingMetadata(
  path: string,
  text: string,
  extractMarkdown: (text: string) => FileMetadata,
): FileMetadata {
  let drawing;
  try {
    drawing = parseDrawing(path, text);
  } catch {
    return { aliases: [], tags: [], links: [], headings: [], blocks: [], tasks: [] };
  }
  const head = drawing.format === 'md' ? extractMarkdown(drawing.head) : undefined;
  const meta: FileMetadata = {
    ...(head ?? { aliases: [], tags: [], headings: [], tasks: [] }),
    headings: [],
    tasks: [],
    links: [],
    blocks: [],
  };
  const link = (raw: string, embed: boolean): LinkRef => ({
    kind: embed ? 'embed' : 'link',
    ...parseWikiLinkContent(raw),
    from: -1,
    to: -1,
  });
  for (const el of drawing.scene.elements) {
    if (el.isDeleted) continue;
    meta.blocks.push({ id: el.id, from: -1, to: -1 });
    const t = el.originalText ?? el.text;
    if (typeof t === 'string')
      for (const m of t.matchAll(/(!?)\[\[([^\[\]\n]+)\]\]/g))
        meta.links.push(link(m[2]!, m[1] === '!'));
    const l = el.link?.trim();
    const m = l ? /^\[\[([^\]]+)\]\]$/.exec(l) : null;
    if (m) meta.links.push(link(m[1]!, false));
  }
  for (const target of Object.values(drawing.embedded)) {
    const m = /\[\[([^\]]+)\]\]/.exec(target);
    if (m) meta.links.push(link(m[1]!, true));
  }
  return meta;
}

export function drawingSearchText(path: string, text: string): string {
  try {
    return drawingText(parseDrawing(path, text).scene);
  } catch {
    return '';
  }
}
