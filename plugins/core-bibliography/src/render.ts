import {
  citationText,
  referenceLine,
  referenceList,
  referenceText,
  type BibEntry,
  type CitationStyle,
} from '@pumice/api';

/** What a note cites: its references in the order of their list, and the number of each. */
export interface Cited {
  list: BibEntry[];
  number: Map<string, number>;
  style: CitationStyle;
}

export function citedOf(
  keys: string[],
  entries: ReadonlyMap<string, BibEntry>,
  style: CitationStyle,
): Cited {
  const list = referenceList(keys, entries, style);
  return { list, number: new Map(list.map((e, i) => [e.key, i + 1])), style };
}

/** How a citation of `entry` reads; `bracketed`: within brackets written in the text. */
export function citeText(cited: Cited, entry: BibEntry, bracketed: boolean): string {
  return citationText(entry, {
    style: cited.style,
    number: cited.number.get(entry.key) ?? 0,
    bracketed,
  });
}

/** Whether a citation stands in brackets written before it on its line: `[see @key`. */
export function inBrackets(before: string): boolean {
  return before.lastIndexOf('[') > before.lastIndexOf(']');
}

/** The list of references under a note. `open`: called for a link in it. */
export function referencesElement(cited: Cited, open: (url: string) => void): HTMLElement {
  const section = document.createElement('section');
  section.className = 'pm-references';
  const title = document.createElement('h2');
  title.textContent = 'References';
  const list = document.createElement(cited.style === 'numeric' ? 'ol' : 'ul');
  for (const entry of cited.list) {
    const item = document.createElement('li');
    item.dataset.key = entry.key;
    for (const part of referenceText(entry)) {
      if (!part.em) item.append(part.text);
      else {
        const em = document.createElement('em');
        em.textContent = part.text;
        item.append(em);
      }
    }
    if (entry.url) {
      const link = document.createElement('a');
      link.className = 'pm-reference-link';
      link.href = entry.url;
      link.textContent = entry.fields.doi ? 'doi' : 'link';
      link.title = entry.url;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        open(entry.url!);
      });
      item.append(' ', link);
    }
    list.append(item);
  }
  section.append(title, list);
  return section;
}

export { referenceLine };
