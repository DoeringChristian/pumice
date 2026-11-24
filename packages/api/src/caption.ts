import { parseWikiLinkContent, type WikiLinkParts } from '@pumice/markdown';

/** A caption as text and the links in it (`As in [[#^fig-setup]]`, `As in @fig-setup`). */
export function captionParts(caption: string): Array<string | WikiLinkParts> {
  const parts: Array<string | WikiLinkParts> = [];
  let at = 0;
  // `[[#^fig-setup]]`, or `@fig-setup` for the same.
  const link =
    /\[\[([^[\]\n]+)\]\]|(?<![A-Za-z0-9@])@((?:fig|tab|eq)(?:-[A-Za-z0-9][A-Za-z0-9-]*|\d+))(?![A-Za-z0-9])/gi;
  for (const m of caption.matchAll(link)) {
    if (m.index > at) parts.push(caption.slice(at, m.index));
    parts.push(
      m[1] !== undefined ? parseWikiLinkContent(m[1]) : { target: '', subpath: `^${m[2]!}` },
    );
    at = m.index + m[0].length;
  }
  if (at < caption.length) parts.push(caption.slice(at));
  return parts;
}

/**
 * Writes a caption into `el`: its text, and each link in it as it reads ("Figure 2"), as a
 * link of a rendered note (`a.internal-link` with `data-target` and `data-subpath`).
 */
export function fillCaption(
  el: HTMLElement,
  caption: string,
  linkText: (link: WikiLinkParts) => string,
): void {
  el.replaceChildren(
    ...captionParts(caption).map((part) => {
      if (typeof part === 'string') return part;
      const a = document.createElement('a');
      a.className = 'internal-link pm-caption-ref';
      a.dataset.target = part.target;
      if (part.subpath) a.dataset.subpath = part.subpath;
      a.textContent = part.alias || linkText(part);
      return a;
    }),
  );
}
