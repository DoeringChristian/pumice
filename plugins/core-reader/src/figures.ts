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
