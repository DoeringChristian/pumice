import type { VaultPath } from '@pumice/platform';
import type { BlockRef, FileMetadata, HeadingRef, LinkRef } from '@pumice/markdown';
import type { Disposable, Event } from '../lifecycle';
import { defineService } from '../service';

export interface IndexedFile {
  path: VaultPath;
  /** Display title: `title` property, else the file name without extension. */
  title: string;
  /** File name without the last extension (`.excalidraw.md` counts as one extension). */
  name: string;
  extension: string;
  size: number;
  mtime: number;
  /** Parsed metadata, for markdown and files handled by an extractor. */
  meta?: FileMetadata;
}

/** `plugin`: resolved by a registered {@link LinkResolver} (e.g. note IDs). */
export type ResolvedVia = 'self' | 'plugin' | 'path' | 'name' | 'alias';

/**
 * Extra link resolution, tried before the built-in rules (path, name, alias). Returns the
 * target's path, or undefined to pass.
 */
export type LinkResolver = (target: string, from: VaultPath) => VaultPath | undefined;

export interface ResolvedLink {
  source: VaultPath;
  link: LinkRef;
  /** Resolved target path; undefined when unresolved. */
  target?: VaultPath;
  via?: ResolvedVia;
}

export interface SearchOptions {
  limit?: number;
  /** Only files under this folder. */
  folder?: VaultPath;
}

export interface SearchMatch {
  path: VaultPath;
  score: number;
  /** Matched excerpts with `[from, to)` ranges of the hits inside `text`. */
  snippets: Array<{ text: string; hits: Array<[number, number]>; offset: number }>;
}

/** Plugin metadata extraction for non-markdown files (e.g. drawings) or extra properties. */
export interface MetadataExtractor {
  id: string;
  /** File name endings handled, longest match wins over the markdown extractor. */
  extensions: string[];
  extract(path: VaultPath, text: string): FileMetadata;
  /** Searchable text (default: the raw file). */
  searchText?(path: VaultPath, text: string): string;
}

export interface MetadataIndexApi {
  /** Resolves once the initial scan is done (warm cache: almost immediately). */
  readonly ready: Promise<void>;
  readonly isReady: boolean;

  files(): IndexedFile[];
  getFile(path: VaultPath): IndexedFile | undefined;

  /** Resolves a link target (path, name or alias; plugins may add more) as seen from `from`. */
  resolve(target: string, from: VaultPath): { file: IndexedFile; via: ResolvedVia } | undefined;
  /** Range of `#Heading` / `#^block` inside a file. */
  resolveSubpath(path: VaultPath, subpath: string): HeadingRef | BlockRef | undefined;

  outgoing(path: VaultPath): ResolvedLink[];
  backlinks(path: VaultPath): ResolvedLink[];
  /** Links whose target doesn't resolve, by source. */
  unresolved(): ResolvedLink[];

  /** Tag → number of occurrences (nested tags counted for each parent too). */
  tags(): Map<string, number>;
  filesWithTag(tag: string): IndexedFile[];

  search(query: string, opts?: SearchOptions): Promise<SearchMatch[]>;

  registerExtractor(extractor: MetadataExtractor): Disposable;
  /** Adds a link resolver; links are resolved again when it is added or removed. */
  registerResolver(resolver: LinkResolver): Disposable;
  /** Tells the index that a resolver's answers changed: all links are resolved again. */
  invalidateLinks(): void;
  /** Drops the cache and indexes everything again. */
  rebuild(): Promise<void>;
  /** Fires with changed paths (created, modified, deleted, renamed — both old and new paths). */
  readonly onDidChange: Event<VaultPath[]>;
}

export const MetadataIndex = defineService<MetadataIndexApi>('core.index');
