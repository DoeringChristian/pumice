import {
  dirname,
  normalizePath,
  type IndexedFile,
  type ResolvedVia,
  type VaultPath,
} from '@pumice/api';

/** Case- and normalization-insensitive key for names and aliases. */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase().trim();

const HAS_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

export interface Lookup {
  file(path: VaultPath): IndexedFile | undefined;
  byName(key: string): Iterable<VaultPath>;
  byAlias(key: string): Iterable<VaultPath>;
  /** Files whose path ends with `/suffix` (or equals it), compared case-insensitively. */
  bySuffix(suffix: string): Iterable<VaultPath>;
}

/** Number of leading folder segments two paths share. */
function commonDepth(a: VaultPath, b: VaultPath): number {
  const x = dirname(a).split('/');
  const y = dirname(b).split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== '') n++;
  return n;
}

/** Picks among candidates: shortest path first, then the one closest to the source. */
function best(
  paths: Iterable<VaultPath>,
  from: VaultPath,
  lookup: Lookup,
): IndexedFile | undefined {
  let pick: IndexedFile | undefined;
  for (const path of paths) {
    const file = lookup.file(path);
    if (!file) continue;
    if (
      !pick ||
      path.length < pick.path.length ||
      (path.length === pick.path.length &&
        commonDepth(path, from) > commonDepth(pick.path, from)) ||
      (path.length === pick.path.length &&
        commonDepth(path, from) === commonDepth(pick.path, from) &&
        path < pick.path)
    ) {
      pick = file;
    }
  }
  return pick;
}

/** Link resolution as in Obsidian: path, then name (shortest path wins), then alias. */
export function resolveTarget(
  target: string,
  from: VaultPath,
  lookup: Lookup,
): { file: IndexedFile; via: ResolvedVia } | undefined {
  const t = target.trim();
  if (!t) {
    const self = lookup.file(from);
    return self ? { file: self, via: 'self' } : undefined;
  }
  if (t.includes('/') || HAS_EXTENSION.test(t)) {
    const candidates = [normalizePath(t), normalizePath(`${dirname(from)}/${t}`)];
    for (const c of candidates) {
      const file = lookup.file(c) ?? lookup.file(`${c}.md`);
      if (file) return { file, via: 'path' };
    }
    const suffix = normalizePath(t);
    const file =
      best(lookup.bySuffix(suffix), from, lookup) ??
      best(lookup.bySuffix(`${suffix}.md`), from, lookup);
    if (file) return { file, via: 'path' };
  }
  const byName = best(lookup.byName(nameKey(t)), from, lookup);
  if (byName) return { file: byName, via: 'name' };
  const byAlias = best(lookup.byAlias(nameKey(t)), from, lookup);
  if (byAlias) return { file: byAlias, via: 'alias' };
  return undefined;
}
