import {
  embedCaption,
  fillCaption,
  figureLabel,
  figureReference,
  isFigureTarget,
  numberItems,
  type NumberedItem,
  type WikiLinkParts,
} from '@pumice/api';

/**
 * Numbers the figures, tables and equations of a rendered note. The text says which of them
 * are numbered (`numberItems`); here they are found again on the page, by their position among
 * all pictures and frames, all tables, all display equations.
 */

/** Not part of a note embedded in this one. */
const own = (el: Element) => !el.parentElement?.closest('.pm-embed');

/** Puts the caption (and number) under an embedded picture, video or frame. */
export function setEmbedCaption(
  el: HTMLElement,
  item: NumberedItem | undefined,
  /** How a link in the caption reads ("Figure 2"). */
  linkText: (link: WikiLinkParts) => string = (link) => link.subpath ?? link.target,
): void {
  el.querySelector(':scope > .pm-caption')?.remove();
  const caption = isFigureTarget(el.dataset.target ?? '')
    ? embedCaption(el.dataset.alias)
    : undefined;
  if (!item && !caption) return;
  const out = document.createElement('span');
  out.className = 'pm-caption';
  if (item) {
    const label = document.createElement('span');
    label.className = 'pm-caption-label';
    label.textContent = caption ? `${figureLabel(item)}: ` : figureLabel(item);
    out.append(label);
  }
  if (caption) {
    const text = document.createElement('span');
    fillCaption(text, caption, linkText);
    out.append(text);
  }
  el.append(out);
}

const mark = (el: HTMLElement, text: string) => {
  el.setAttribute('data-figure', '');
  el.style.setProperty('--pm-figure', JSON.stringify(text));
};

export interface Numbering {
  /** How a reference to a label of this note reads ("Figure 2"), if it has that label. */
  reference(id: string): string | undefined;
  /** The numbered item of an embed, to caption it whenever it is rendered. */
  embed(el: HTMLElement): NumberedItem | undefined;
  /** Marks what was put in place of a frame block. */
  frame(pre: HTMLElement, host: HTMLElement): void;
}

/**
 * Call right after the note's HTML is in place (before embeds and code blocks are rendered into
 * it): tables and equations are numbered at once, embeds and frames through the result.
 */
export function numberRendered(container: HTMLElement, markdown: string): Numbering {
  const items = numberItems(markdown);
  const of = (kind: NumberedItem['kind']) =>
    new Map(items.filter((i) => i.kind === kind).map((i) => [i.ordinal, i]));

  const figures = of('fig');
  const byElement = new Map<Element, NumberedItem>();
  [...container.querySelectorAll<HTMLElement>('.pm-embed, pre.pm-code-block')]
    .filter(own)
    .filter((el) =>
      el.matches('.pm-embed')
        ? isFigureTarget(el.dataset.target ?? '')
        : el.dataset.lang === 'frame',
    )
    .forEach((el, ordinal) => {
      const item = figures.get(ordinal);
      if (item) byElement.set(el, item);
    });

  const tables = of('tab');
  [...container.querySelectorAll<HTMLElement>('table')].filter(own).forEach((table, ordinal) => {
    const item = tables.get(ordinal);
    // The caption is the paragraph above the table ("Table: …").
    const above = (table.closest('.pm-table-wrap') ?? table).previousElementSibling;
    if (!item || !(above instanceof HTMLElement) || above.tagName !== 'P') return;
    const text = above.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE || !/^\s*Table:/i.test(text.textContent ?? ''))
      return;
    text.textContent = (text.textContent ?? '').replace(/^\s*Table:/i, '');
    const label = document.createElement('span');
    label.className = 'pm-caption-label';
    label.textContent = item.caption ? `${figureLabel(item)}:` : figureLabel(item);
    above.prepend(label);
    above.classList.add('pm-caption-line');
  });

  const equations = of('eq');
  [...container.querySelectorAll<HTMLElement>('.pm-math.is-display')]
    .filter(own)
    .forEach((el, ordinal) => {
      const item = equations.get(ordinal);
      if (item) mark(el, figureReference(item));
    });

  return {
    reference: (id) => {
      const item = items.find((i) => i.id === id);
      return item && figureReference(item);
    },
    embed: (el) => byElement.get(el),
    frame: (pre, host) => {
      const item = byElement.get(pre);
      if (item) mark(host, figureLabel(item));
    },
  };
}

/**
 * Lines of a paragraph that hold figures become paragraphs of their own: two lines of two
 * pictures each are two rows, as they are where the note is written (a paragraph is one
 * block to the renderer, and all four would share one row that wraps where it likes).
 */
export function splitFigureLines(container: HTMLElement): void {
  for (const p of [...container.querySelectorAll('p')]) {
    if (!p.querySelector(':scope > .pm-embed')) continue;
    const lines: Node[][] = [[]];
    for (const node of [...p.childNodes]) {
      if (node.nodeName === 'BR') lines.push([]);
      else if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes('\n')) {
        node.textContent.split('\n').forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part) lines[lines.length - 1]!.push(document.createTextNode(part));
        });
      } else lines[lines.length - 1]!.push(node);
    }
    const has = (line: Node[]) => line.some((n) => n instanceof Element && n.matches('.pm-embed'));
    const empty = (line: Node[]) =>
      line.every((n) => !(n instanceof Element) && !n.textContent?.trim());
    // Lines of text that follow each other stay one paragraph.
    const groups: Node[][] = [];
    let text = false;
    for (const line of lines.filter((l) => !empty(l))) {
      if (!has(line) && text)
        groups[groups.length - 1]!.push(document.createTextNode('\n'), ...line);
      else groups.push(line);
      text = !has(line);
    }
    if (groups.length < 2) continue;
    const made = groups.map((nodes, i) => {
      const part = p.cloneNode(false) as HTMLElement;
      part.append(...nodes);
      // Close to each other, as lines of one paragraph are.
      if (i > 0) part.classList.add('pm-line-after');
      if (i < groups.length - 1) part.classList.add('pm-line-before');
      return part;
    });
    p.replaceWith(...made);
  }
}
