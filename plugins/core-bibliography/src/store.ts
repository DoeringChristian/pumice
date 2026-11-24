import {
  Emitter,
  parseBibtex,
  type BibEntry,
  type MetadataIndexApi,
  type VaultApi,
  type VaultPath,
} from '@pumice/api';

const isBib = (path: string) => /\.bib(tex)?$/i.test(path);

/** The BibTeX files of the vault, read when a note asks for them and again when they change. */
export class BibStore {
  private readonly files = new Map<VaultPath, Map<string, BibEntry>>();
  private readonly loading = new Map<VaultPath, Promise<void>>();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly vault: VaultApi,
    private readonly index: MetadataIndexApi,
    /** The file every note cites from that names none (a setting). */
    private readonly defaultFile: () => string,
  ) {}

  /** A file changed or went: it is read again when it is next asked for. */
  invalidate(paths: VaultPath[]): void {
    let any = false;
    for (const path of paths) {
      if (!isBib(path)) continue;
      this.files.delete(path);
      this.loading.delete(path);
      any = true;
    }
    if (any) this.changed.fire();
  }

  /** Something else that decides what a note cites changed (its properties, a setting). */
  touch(): void {
    this.changed.fire();
  }

  /**
   * The files a note cites from: what its `bibliography` property names (a file or a list,
   * as in pandoc; `[[refs.bib]]` too), else the vault's default file, else the `.bib` files
   * at the top of the vault.
   */
  sourcesFor(note: VaultPath): VaultPath[] {
    const named = this.index.getFile(note)?.meta?.frontmatter?.bibliography;
    const list = (Array.isArray(named) ? named : named ? [named] : [])
      .filter((v): v is string => typeof v === 'string')
      .map((v) =>
        v
          .trim()
          .replace(/^\[\[|\]\]$/g, '')
          .replace(/\|.*$/, ''),
      );
    const dir = note.includes('/') ? note.slice(0, note.lastIndexOf('/')) : '';
    const find = (target: string): VaultPath | undefined => {
      const resolved = this.index.resolve(target, note)?.file.path;
      if (resolved) return resolved;
      const clean = target.replace(/^\.\//, '').replace(/^\/+/, '');
      for (const path of [dir ? `${dir}/${clean}` : clean, clean, `${clean}.bib`])
        if (this.vault.get(path)?.kind === 'file') return path;
      return undefined;
    };
    const found = list.flatMap((t) => find(t) ?? []);
    if (list.length) return found;
    const fallback = this.defaultFile().trim();
    const chosen = fallback ? find(fallback) : undefined;
    if (chosen) return [chosen];
    return this.vault
      .files()
      .map((f) => f.path)
      .filter((p) => !p.includes('/') && isBib(p))
      .sort();
  }

  private load(path: VaultPath): Promise<void> {
    let job = this.loading.get(path);
    if (!job) {
      job = this.vault
        .read(path)
        .then((text) => new Map(parseBibtex(text).map((e) => [e.key, e])))
        .catch(() => new Map<string, BibEntry>())
        .then((entries) => {
          // Changed again while it was read: that reading counts.
          if (this.loading.get(path) !== job) return;
          this.files.set(path, entries);
          this.changed.fire();
        });
      this.loading.set(path, job);
    }
    return job;
  }

  entries(note: VaultPath): ReadonlyMap<string, BibEntry> {
    const all = new Map<string, BibEntry>();
    for (const path of this.sourcesFor(note)) {
      const entries = this.files.get(path);
      if (!entries) void this.load(path);
      // The file named first wins.
      else for (const [key, entry] of entries) if (!all.has(key)) all.set(key, entry);
    }
    return all;
  }

  async ready(note: VaultPath): Promise<void> {
    await Promise.all(this.sourcesFor(note).map((path) => this.load(path)));
  }

  fileOf(note: VaultPath, key: string): VaultPath | undefined {
    return this.sourcesFor(note).find((path) => this.files.get(path)?.has(key));
  }
}
