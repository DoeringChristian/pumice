import {
  Emitter,
  basename,
  headingKey,
  type BlockRef,
  type Disposable,
  type DocumentsApi,
  type FileMetadata,
  type HeadingRef,
  type IndexedFile,
  type LinkResolver,
  type MetadataExtractor,
  type MetadataIndexApi,
  type PluginStorage,
  type ResolvedLink,
  type ResolvedVia,
  type SearchMatch,
  type SearchOptions,
  type VaultApi,
  type VaultChange,
  type VaultFile,
  type VaultPath,
} from '@pumice/api';
import type { ParserHost } from './parser-host';
import { nameKey, resolveTarget, type Lookup } from './resolve';
import { SearchIndex } from './search';

/** Bump when the snapshot format or the parser output changes: forces a rebuild. */
export const INDEX_VERSION = 3;
const SNAPSHOT_KEY = 'snapshot';

interface Snapshot {
  version: number;
  files: IndexedFile[];
  search: string;
}

export interface IndexOptions {
  vault: VaultApi;
  documents: DocumentsApi;
  parser: ParserHost;
  storage?: PluginStorage;
  now?: () => number;
  /** Delay before re-indexing an open document after an edit. */
  liveDelay?: number;
  /** Delay before writing the snapshot after changes. */
  persistDelay?: number;
}

const isMarkdown = (path: VaultPath) => path.toLowerCase().endsWith('.md');

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function removeFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (!set.size) map.delete(key);
}

/** File name without the final `.md` (other extensions are part of the name, as in Obsidian). */
export function noteName(path: VaultPath): string {
  const name = basename(path);
  return isMarkdown(name) ? name.slice(0, -3) : name;
}

export class MetadataIndexImpl implements MetadataIndexApi, Disposable {
  private readonly files_ = new Map<VaultPath, IndexedFile>();
  private readonly names = new Map<string, Set<VaultPath>>();
  private readonly aliases = new Map<string, Set<VaultPath>>();
  /** Lowercased path → path (for suffix lookups). */
  private readonly lowerPaths = new Map<string, VaultPath>();
  private readonly outgoing_ = new Map<VaultPath, ResolvedLink[]>();
  private readonly incoming = new Map<VaultPath, Set<VaultPath>>();
  private readonly resolvers: LinkResolver[] = [];
  private readonly extractors: MetadataExtractor[] = [];
  private readonly search_ = new SearchIndex();
  private resolutionDirty = true;
  private tagCounts: Map<string, number> | undefined;

  private readonly changed = new Emitter<VaultPath[]>();
  readonly onDidChange = this.changed.event;
  private pendingChanged = new Set<VaultPath>();
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly queue = new Set<VaultPath>();
  private draining: Promise<void> | undefined;
  private readonly liveTimers = new Map<VaultPath, ReturnType<typeof setTimeout>>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: Disposable[] = [];
  private disposed = false;

  private readyResolve!: () => void;
  readonly ready = new Promise<void>((r) => (this.readyResolve = r));
  isReady = false;

  private readonly now: () => number;
  private readonly liveDelay: number;
  private readonly persistDelay: number;

  constructor(private readonly opts: IndexOptions) {
    this.now = opts.now ?? Date.now;
    this.liveDelay = opts.liveDelay ?? 300;
    this.persistDelay = opts.persistDelay ?? 3000;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    const snapshot = await this.loadSnapshot();
    const cached = new Map(snapshot?.files.map((f) => [f.path, f]) ?? []);
    if (snapshot) {
      this.search_.load(snapshot.search);
    }
    for (const file of this.opts.vault.files()) {
      const old = cached.get(file.path);
      cached.delete(file.path);
      if (
        old &&
        old.size === file.size &&
        old.mtime === file.mtime &&
        (old.meta || !this.parses(file.path))
      ) {
        this.insert(old);
      } else {
        this.insert(this.entryFor(file, old));
        if (this.parses(file.path)) this.queue.add(file.path);
        else this.search_.remove(file.path);
      }
    }
    // Files gone while we weren't looking.
    for (const path of cached.keys()) this.search_.remove(path);

    this.subscriptions.push(
      this.opts.vault.onDidChange((changes) => this.onVaultChange(changes)),
      this.opts.documents.onDidChange((path) => this.onDocumentChange(path)),
    );
    this.resolutionDirty = true;
    this.markChanged([...this.files_.keys()]);
    void this.drain().then(() => {
      this.isReady = true;
      this.readyResolve();
      this.schedulePersist();
    });
  }

  async rebuild(): Promise<void> {
    await this.opts.storage?.delete(SNAPSHOT_KEY);
    this.search_.clear();
    for (const path of this.files_.keys()) if (this.parses(path)) this.queue.add(path);
    await this.drain();
    this.resolutionDirty = true;
    this.markChanged([...this.files_.keys()]);
    this.schedulePersist();
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions) s.dispose();
    for (const t of this.liveTimers.values()) clearTimeout(t);
    clearTimeout(this.persistTimer);
    clearTimeout(this.changeTimer);
    this.changed.dispose();
    this.opts.parser.dispose();
  }

  /** Writes the snapshot now (on pause/quit) and waits for queued work (tests). */
  async flush(): Promise<void> {
    await this.drain();
    for (const [path, timer] of this.liveTimers) {
      clearTimeout(timer);
      this.liveTimers.delete(path);
      this.queue.add(path);
    }
    await this.drain();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.persist();
    }
    this.fireChanged();
  }

  // -------------------------------------------------------------------------------------------
  // Queries

  files(): IndexedFile[] {
    return [...this.files_.values()];
  }

  getFile(path: VaultPath): IndexedFile | undefined {
    return this.files_.get(path);
  }

  resolve(target: string, from: VaultPath): { file: IndexedFile; via: ResolvedVia } | undefined {
    if (target.trim()) {
      for (const resolver of this.resolvers) {
        const path = resolver(target.trim(), from);
        const file = path !== undefined ? this.files_.get(path) : undefined;
        if (file) return { file, via: 'plugin' };
      }
    }
    return resolveTarget(target, from, this.lookup);
  }

  registerResolver(resolver: LinkResolver): Disposable {
    this.resolvers.push(resolver);
    this.invalidateLinks();
    return {
      dispose: () => {
        const i = this.resolvers.indexOf(resolver);
        if (i >= 0) this.resolvers.splice(i, 1);
        this.invalidateLinks();
      },
    };
  }

  invalidateLinks(): void {
    this.resolutionDirty = true;
    // Everything that shows links (editors, backlinks, graph) listens to changes.
    for (const path of this.files_.keys()) this.pendingChanged.add(path);
    this.markChanged([]);
  }

  resolveSubpath(path: VaultPath, subpath: string): HeadingRef | BlockRef | undefined {
    const meta = this.files_.get(path)?.meta;
    if (!meta) return undefined;
    const sub = subpath.replace(/^#/, '');
    if (sub.startsWith('^')) {
      const id = sub.slice(1);
      return meta.blocks.find((b) => b.id === id);
    }
    // `A#B`: heading B below heading A.
    let found: HeadingRef | undefined;
    let from = 0;
    for (const part of sub.split('#').map(headingKey).filter(Boolean)) {
      found = meta.headings.find((h) => h.from >= from && headingKey(h.text) === part);
      if (!found) return undefined;
      from = found.to;
    }
    return found;
  }

  outgoing(path: VaultPath): ResolvedLink[] {
    this.ensureResolved();
    return this.outgoing_.get(path) ?? [];
  }

  backlinks(path: VaultPath): ResolvedLink[] {
    this.ensureResolved();
    const out: ResolvedLink[] = [];
    for (const source of this.incoming.get(path) ?? []) {
      for (const link of this.outgoing_.get(source) ?? []) if (link.target === path) out.push(link);
    }
    return out;
  }

  unresolved(): ResolvedLink[] {
    this.ensureResolved();
    const out: ResolvedLink[] = [];
    for (const links of this.outgoing_.values()) for (const l of links) if (!l.target) out.push(l);
    return out;
  }

  tags(): Map<string, number> {
    if (!this.tagCounts) {
      const counts = new Map<string, number>();
      for (const file of this.files_.values()) {
        for (const { tag } of file.meta?.tags ?? []) {
          const parts = tag.split('/');
          for (let i = 1; i <= parts.length; i++) {
            const key = parts.slice(0, i).join('/');
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
      this.tagCounts = counts;
    }
    return this.tagCounts;
  }

  filesWithTag(tag: string): IndexedFile[] {
    const key = tag.replace(/^#/, '').toLowerCase();
    return this.files().filter((f) =>
      f.meta?.tags.some(({ tag: t }) => {
        const lower = t.toLowerCase();
        return lower === key || lower.startsWith(`${key}/`);
      }),
    );
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchMatch[]> {
    const hits = this.search_.query(query, (path) =>
      opts.folder ? path.startsWith(`${opts.folder}/`) : this.files_.has(path),
    );
    const limit = opts.limit ?? 50;
    const out: SearchMatch[] = [];
    for (const hit of hits.slice(0, limit)) {
      let text = '';
      try {
        text = await this.opts.documents.read(hit.path);
      } catch {
        continue;
      }
      out.push({
        path: hit.path,
        score: hit.score,
        snippets: this.search_.snippets(text, hit.terms),
      });
    }
    return out;
  }

  registerExtractor(extractor: MetadataExtractor): Disposable {
    this.extractors.push(extractor);
    for (const path of this.files_.keys())
      if (this.extractorFor(path) === extractor) this.queue.add(path);
    void this.drain();
    return {
      dispose: () => {
        const i = this.extractors.indexOf(extractor);
        if (i >= 0) this.extractors.splice(i, 1);
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Bookkeeping

  private readonly lookup: Lookup = {
    file: (path) => this.files_.get(path),
    byName: (key) => this.names.get(key) ?? [],
    byAlias: (key) => this.aliases.get(key) ?? [],
    bySuffix: (suffix) => {
      const lower = suffix.toLowerCase();
      const out: VaultPath[] = [];
      for (const [lp, path] of this.lowerPaths)
        if (lp === lower || lp.endsWith(`/${lower}`)) out.push(path);
      return out;
    },
  };

  private extractorFor(path: VaultPath): MetadataExtractor | undefined {
    const lower = path.toLowerCase();
    let best: MetadataExtractor | undefined;
    let length = 0;
    for (const e of this.extractors) {
      for (const ext of e.extensions) {
        if (lower.endsWith(`.${ext.toLowerCase()}`) && ext.length > length) {
          best = e;
          length = ext.length;
        }
      }
    }
    return best;
  }

  private parses(path: VaultPath): boolean {
    return isMarkdown(path) || this.extractorFor(path) !== undefined;
  }

  private entryFor(file: VaultFile, previous?: IndexedFile): IndexedFile {
    const entry: IndexedFile = {
      path: file.path,
      title: previous?.meta?.title ?? noteName(file.path),
      name: noteName(file.path),
      extension: file.extension,
      size: file.size,
      mtime: file.mtime,
    };
    if (previous?.meta) entry.meta = previous.meta;
    return entry;
  }

  /** Adds a file to all lookup tables. */
  private insert(file: IndexedFile): void {
    this.files_.set(file.path, file);
    this.lowerPaths.set(file.path.toLowerCase(), file.path);
    addTo(this.names, nameKey(file.name), file.path);
    for (const alias of file.meta?.aliases ?? []) addTo(this.aliases, nameKey(alias), file.path);
    this.tagCounts = undefined;
  }

  private remove(path: VaultPath): IndexedFile | undefined {
    const file = this.files_.get(path);
    if (!file) return undefined;
    this.files_.delete(path);
    this.lowerPaths.delete(path.toLowerCase());
    removeFrom(this.names, nameKey(file.name), path);
    for (const alias of file.meta?.aliases ?? []) removeFrom(this.aliases, nameKey(alias), path);
    this.outgoing_.delete(path);
    this.tagCounts = undefined;
    return file;
  }

  /** Identity-relevant fields; when they change, every link must be re-resolved. */
  private identity(file: IndexedFile | undefined): string {
    if (!file) return '';
    return JSON.stringify([file.path, file.name, file.meta?.aliases ?? []]);
  }

  private applyMetadata(path: VaultPath, meta: FileMetadata, searchText: string): void {
    const old = this.files_.get(path);
    if (!old) return;
    const before = this.identity(old);
    this.remove(path);
    const next: IndexedFile = { ...old, meta, title: meta.title ?? old.name };
    this.insert(next);
    this.search_.set(path, {
      title: next.title,
      aliases: meta.aliases.join(' '),
      body: searchText,
    });
    if (this.identity(next) !== before) this.resolutionDirty = true;
    else if (!this.resolutionDirty) this.resolveFile(path);
    this.markChanged([path]);
  }

  private async indexFile(path: VaultPath): Promise<void> {
    if (!this.files_.has(path) || !this.parses(path)) return;
    let text: string;
    try {
      text = await this.opts.documents.read(path);
    } catch {
      return; // gone meanwhile
    }
    const extractor = this.extractorFor(path);
    let meta: FileMetadata;
    let searchText = text;
    if (extractor) {
      meta = extractor.extract(path, text);
      searchText = extractor.searchText?.(path, text) ?? text;
    } else {
      meta = await this.opts.parser.parse(text);
      if (meta.frontmatterRange) searchText = text.slice(meta.frontmatterRange.to);
    }
    if (this.disposed) return;
    this.applyMetadata(path, meta, searchText);
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = async () => {
      while (this.queue.size && !this.disposed) {
        const batch = [...this.queue].slice(0, 16);
        for (const p of batch) this.queue.delete(p);
        await Promise.all(batch.map((p) => this.indexFile(p)));
      }
    };
    this.draining = run().finally(() => {
      this.draining = undefined;
      this.schedulePersist();
    });
    return this.draining;
  }

  private ensureResolved(): void {
    if (!this.resolutionDirty) return;
    this.resolutionDirty = false;
    this.outgoing_.clear();
    this.incoming.clear();
    for (const path of this.files_.keys()) this.resolveFile(path);
  }

  private resolveFile(path: VaultPath): void {
    for (const old of this.outgoing_.get(path) ?? [])
      if (old.target) removeFrom(this.incoming, old.target, path);
    const file = this.files_.get(path);
    const links: ResolvedLink[] = [];
    for (const link of file?.meta?.links ?? []) {
      const r = this.resolve(link.target, path);
      const resolved: ResolvedLink = { source: path, link };
      if (r) {
        resolved.target = r.file.path;
        resolved.via = r.via;
        addTo(this.incoming, r.file.path, path);
      }
      links.push(resolved);
    }
    if (file) this.outgoing_.set(path, links);
  }

  private onVaultChange(changes: VaultChange[]): void {
    const touched: VaultPath[] = [];
    for (const change of changes) {
      if (change.type === 'create' || change.type === 'modify') {
        if (change.entry.kind !== 'file') continue;
        const file = change.entry;
        const old = this.files_.get(file.path);
        if (old && old.size === file.size && old.mtime === file.mtime) continue;
        if (old) this.remove(file.path);
        this.insert(this.entryFor(file, old));
        // Open documents are indexed from their live content instead.
        if (this.parses(file.path)) this.queue.add(file.path);
        this.resolutionDirty = true;
        touched.push(file.path);
      } else if (change.type === 'delete') {
        const removed = [...this.files_.keys()].filter(
          (p) => p === change.path || p.startsWith(`${change.path}/`),
        );
        for (const p of removed) {
          this.remove(p);
          this.search_.remove(p);
        }
        if (removed.length) this.resolutionDirty = true;
        touched.push(...removed);
      } else if (change.type === 'rename') {
        const prefix = change.oldPath;
        const moved = [...this.files_.keys()].filter(
          (p) => p === prefix || p.startsWith(`${prefix}/`),
        );
        for (const oldPath of moved) {
          const newPath = change.entry.path + oldPath.slice(prefix.length);
          const file = this.remove(oldPath)!;
          const name = noteName(newPath);
          const next: IndexedFile = {
            ...file,
            path: newPath,
            name,
            title: file.meta?.title ?? name,
          };
          this.insert(next);
          this.search_.rename(oldPath, newPath, next.title);
          if (this.parses(newPath)) this.queue.add(newPath);
          touched.push(oldPath, newPath);
        }
        if (moved.length) this.resolutionDirty = true;
      }
    }
    if (touched.length) this.markChanged(touched);
    void this.drain();
  }

  private onDocumentChange(path: VaultPath): void {
    if (!this.files_.has(path) || !this.parses(path)) return;
    clearTimeout(this.liveTimers.get(path));
    this.liveTimers.set(
      path,
      setTimeout(() => {
        this.liveTimers.delete(path);
        this.queue.add(path);
        void this.drain();
      }, this.liveDelay),
    );
  }

  private markChanged(paths: VaultPath[]): void {
    for (const p of paths) this.pendingChanged.add(p);
    this.schedulePersist();
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => this.fireChanged(), 50);
  }

  private fireChanged(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    if (!this.pendingChanged.size || this.disposed) return;
    const paths = [...this.pendingChanged];
    this.pendingChanged.clear();
    this.changed.fire(paths);
  }

  // -------------------------------------------------------------------------------------------
  // Persistence (a disposable cache in app storage, never in the vault)

  private async loadSnapshot(): Promise<Snapshot | undefined> {
    try {
      const raw = await this.opts.storage?.get(SNAPSHOT_KEY);
      if (!raw) return undefined;
      const snapshot = JSON.parse(raw) as Snapshot;
      return snapshot.version === INDEX_VERSION ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  private schedulePersist(): void {
    if (!this.opts.storage || this.disposed || !this.isReady) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, this.persistDelay);
  }

  private async persist(): Promise<void> {
    if (!this.opts.storage) return;
    const snapshot: Snapshot = {
      version: INDEX_VERSION,
      files: this.files(),
      search: this.search_.serialize(),
    };
    try {
      await this.opts.storage.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('[core.index] could not save the index cache', e);
    }
  }
}
