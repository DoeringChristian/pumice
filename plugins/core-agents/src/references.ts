/**
 * What an agent's answer refers to in the vault: `[[Plan]]`, `[the plan](Projects/Plan.md)`, and
 * paths as they are written in text or code, with a line if they name one (`Plan.md:12`).
 */

/** A place in the vault as it is written: a path or name, and where in it. */
export interface WrittenPlace {
  path: string;
  /** 1-based. */
  line?: number;
  column?: number;
  subpath?: string;
}

const LINE = /(?::(\d+)(?::(\d+))?(?:-\d+(?::\d+)?)?|#L(\d+)(?:-L?\d+)?)$/;

/** Reads `Projects/Plan.md`, `Plan.md:12`, `Plan.md:12:8-14:2`, `Plan.md#L12`, `Plan.md#Heading`. */
export function parsePlace(text: string): WrittenPlace {
  const t = text
    .trim()
    .replace(/^file:\/\//, '')
    .replace(/^@(?=.)/, '')
    .replace(/^\.\//, '');
  const at = LINE.exec(t);
  if (at) {
    const line = Number(at[1] ?? at[3]);
    return {
      path: t.slice(0, at.index),
      ...(line > 0 ? { line } : {}),
      ...(Number(at[2]) > 0 ? { column: Number(at[2]) } : {}),
    };
  }
  const hash = t.indexOf('#');
  return hash > 0 ? { path: t.slice(0, hash), subpath: t.slice(hash + 1) } : { path: t };
}

const SUFFIX = String.raw`(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:-L?\d+)?)?`;
const IN_TEXT = new RegExp(
  // In quotes, where a name may have spaces; else up to the next space.
  String.raw`["“]([^"“”\n]+\.\w{1,10}${SUFFIX})["”]` +
    String.raw`|(?<![\w/@.:-])@?((?:[^\s"“”'()<>\[\]{},;:|*@\x60]+)\.\w{1,10}${SUFFIX})(?![\w/])`,
  'gu',
);

/** The places in a text that could be files. Whether they are is for the caller to find out. */
export function placesIn(text: string): { from: number; to: number; place: WrittenPlace }[] {
  return [...text.matchAll(IN_TEXT)].map((m) => {
    const written = m[1] ?? m[2]!;
    const from = m.index + m[0].indexOf(written);
    return { from, to: from + written.length, place: parsePlace(written) };
  });
}

/** Where a line (and column) of a text begins. */
export function offsetOf(text: string, line: number, column = 1): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next < 0) return at;
    at = next + 1;
  }
  const end = text.indexOf('\n', at);
  return Math.min(at + column - 1, end < 0 ? text.length : end);
}

type Node = { type: string; url?: string; children?: Node[] };

/** Links to `Plan.md:12` and `file:///…`: not addresses of the web, as their colon suggests. */
export function localLinks(node: Node): void {
  if (node.type === 'link' && node.url) {
    if (/^file:\/\//i.test(node.url)) node.url = node.url.replace(/^file:\/\//i, '');
    else if (/^[^/:\s]+\.\w{1,10}:\d/.test(node.url)) node.url = `./${node.url}`;
  }
  for (const child of node.children ?? []) localLinks(child);
}

export interface PlaceOpener {
  /** The file of the vault a place is in, if there is one. */
  resolve(place: WrittenPlace): string | undefined;
  open(path: string, place: WrittenPlace, newTab: boolean): void;
  openExternal(url: string): void;
}

/** Makes what an answer refers to clickable; what is not in the vault stays text. */
export function linkReferences(root: HTMLElement, opener: PlaceOpener): void {
  const doc = root.ownerDocument;
  const activate = (a: HTMLElement, path: string, place: WrittenPlace) => {
    a.classList.add('pm-agent-reference');
    a.title = path + (place.line ? `, line ${place.line}` : '');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      opener.open(path, place, e.metaKey || e.ctrlKey);
    });
  };
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = a.getAttribute('href') ?? '';
    if (/^(https?|mailto):/i.test(href)) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        opener.openExternal(href);
      });
      continue;
    }
    // (No link leads away from the app.)
    a.addEventListener('click', (e) => e.preventDefault());
    const target = a.dataset.target;
    if (!target) continue;
    const place = parsePlace(a.dataset.subpath ? `${target}#${a.dataset.subpath}` : target);
    const path = opener.resolve(place);
    if (path) activate(a, path, place);
    else a.classList.add('is-unresolved');
  }
  const link = (text: string, path: string, place: WrittenPlace) => {
    const a = doc.createElement('a');
    a.href = '#';
    a.className = 'internal-link';
    a.textContent = text;
    activate(a, path, place);
    return a;
  };
  // Code that is as a whole the name of a file.
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    if (code.closest('a, pre')) continue;
    const text = code.textContent ?? '';
    if (!/\.\w{1,10}(?:$|[:#])|\//.test(text)) continue;
    const place = parsePlace(text.replace(/^\[\[(.*)\]\]$/, '$1'));
    const path = opener.resolve(place);
    if (path) code.replaceChildren(link(text, path, place));
  }
  const walker = doc.createTreeWalker(root, 4 /* text */);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (!n.parentElement?.closest('a, code, pre, .math')) texts.push(n as Text);
  for (const node of texts) {
    const text = node.data;
    const parts: (string | HTMLElement)[] = [];
    let at = 0;
    for (const { from, to, place } of placesIn(text)) {
      const path = opener.resolve(place);
      if (!path) continue;
      parts.push(text.slice(at, from), link(text.slice(from, to), path, place));
      at = to;
    }
    if (at) node.replaceWith(...parts, text.slice(at));
  }
}
