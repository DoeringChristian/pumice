import MiniSearch, { type Options, type SearchResult } from 'minisearch';
import type { VaultPath } from '@pumice/api';

interface SearchDoc {
  id: VaultPath;
  title: string;
  aliases: string;
  body: string;
}

const OPTIONS: Options<SearchDoc> = {
  fields: ['title', 'aliases', 'body'],
  storeFields: [],
  // Diacritics-insensitive, unicode word splitting.
  processTerm: (term) => term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase(),
  tokenize: (text) => text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean),
  searchOptions: { boost: { title: 3, aliases: 2 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
};

const SNIPPET_RADIUS = 60;
const MAX_SNIPPETS = 3;

/** Full-text index over titles, aliases and bodies. Bodies are not stored. */
export class SearchIndex {
  private ms = new MiniSearch<SearchDoc>(OPTIONS);

  load(json: string): void {
    try {
      this.ms = MiniSearch.loadJSON<SearchDoc>(json, OPTIONS);
    } catch {
      this.ms = new MiniSearch<SearchDoc>(OPTIONS);
    }
  }

  serialize(): string {
    return JSON.stringify(this.ms);
  }

  clear(): void {
    this.ms = new MiniSearch<SearchDoc>(OPTIONS);
  }

  set(path: VaultPath, doc: Omit<SearchDoc, 'id'>): void {
    if (this.ms.has(path)) this.ms.discard(path);
    this.ms.add({ id: path, ...doc });
  }

  remove(path: VaultPath): void {
    if (this.ms.has(path)) this.ms.discard(path);
  }

  /** Bodies aren't stored, so a rename keeps the terms by re-adding under the new id lazily. */
  rename(oldPath: VaultPath, newPath: VaultPath, title: string): void {
    if (!this.ms.has(oldPath)) return;
    this.ms.discard(oldPath);
    // The caller re-indexes content on the next change; until then the title is searchable.
    this.ms.add({ id: newPath, title, aliases: '', body: '' });
  }

  query(
    text: string,
    filter: (path: VaultPath) => boolean,
  ): Array<{ path: VaultPath; score: number; terms: string[] }> {
    if (!text.trim()) return [];
    const results: SearchResult[] = this.ms.search(text, {
      filter: (r) => filter(r.id as VaultPath),
    });
    return results.map((r) => ({ path: r.id as VaultPath, score: r.score, terms: r.terms }));
  }

  /** Excerpts of `text` around occurrences of the matched terms. */
  snippets(
    text: string,
    terms: string[],
  ): Array<{ text: string; hits: Array<[number, number]>; offset: number }> {
    if (!terms.length) return [];
    const folded = text.normalize('NFKD');
    // NFKD may change lengths; only use the folded text when it doesn't.
    const haystack = (
      folded.length === text.length ? folded.replace(/\p{M}/gu, (m) => ' '.repeat(m.length)) : text
    ).toLowerCase();
    const hits: Array<[number, number]> = [];
    for (const term of terms) {
      const t = term.toLowerCase();
      let i = haystack.indexOf(t);
      while (i >= 0 && hits.length < 200) {
        const before = i === 0 ? ' ' : haystack[i - 1]!;
        if (!/[\p{L}\p{N}_]/u.test(before)) hits.push([i, i + t.length]);
        i = haystack.indexOf(t, i + t.length);
      }
    }
    hits.sort((a, b) => a[0] - b[0]);
    const out: Array<{ text: string; hits: Array<[number, number]>; offset: number }> = [];
    for (const [from, to] of hits) {
      const last = out[out.length - 1];
      if (last && from < last.offset + last.text.length) {
        last.hits.push([from - last.offset, to - last.offset]);
        continue;
      }
      if (out.length >= MAX_SNIPPETS) break;
      let start = Math.max(0, from - SNIPPET_RADIUS);
      let end = Math.min(text.length, to + SNIPPET_RADIUS);
      const lineStart = text.lastIndexOf('\n', from - 1) + 1;
      const lineEnd = text.indexOf('\n', to);
      if (lineStart > start) start = lineStart;
      if (lineEnd >= 0 && lineEnd < end) end = lineEnd;
      out.push({ text: text.slice(start, end), hits: [[from - start, to - start]], offset: start });
    }
    return out;
  }
}
