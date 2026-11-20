export interface FuzzyResult {
  score: number;
  /** Indices of matched characters in the target. */
  matches: number[];
}

/**
 * Subsequence fuzzy match. Rewards consecutive matches, word starts and early matches.
 * Returns undefined when the query is not a subsequence of the target.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | undefined {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, matches: [] };
  const t = target.toLowerCase();
  const matches: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return undefined;
    const atWordStart = found === 0 || /[\s/_\-.]/.test(t[found - 1]!);
    score += 1;
    if (found === prev + 1) score += 3;
    if (atWordStart) score += 2;
    score -= Math.min(found - ti, 5) * 0.1;
    matches.push(found);
    prev = found;
    ti = found + 1;
  }
  // Prefer shorter targets and exact prefix matches.
  if (t.startsWith(q)) score += 3;
  score -= t.length * 0.01;
  return { score, matches };
}

export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, result: fuzzyMatch(query, text(item)) }))
    .filter((x): x is { item: T; result: FuzzyResult } => !!x.result)
    .sort((a, b) => b.result.score - a.result.score)
    .map((x) => x.item);
}
