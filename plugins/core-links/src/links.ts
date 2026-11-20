import {
  basename,
  dirname,
  formatWikiLink,
  joinPath,
  markdownText,
  normalizePath,
  toDisposable,
  type Disposable,
  type DocumentsApi,
  type IndexedFile,
  type LinkFormatOptions,
  type LinkFormatter,
  type LinkRef,
  type LinkSuggestSource,
  type LinkSuggestion,
  type LinksApi,
  type MetadataIndexApi,
  type VaultApi,
  type VaultPath,
  type WorkspaceApi,
} from '@pumice/api';
import { fuzzyMatch } from '@pumice/ui';

export interface LinksOptions {
  vault: VaultApi;
  documents: DocumentsApi;
  index: MetadataIndexApi;
  workspace?: WorkspaceApi;
  /** Folder for notes created from unresolved links: '' = vault root, '.' = next to the source. */
  newNoteFolder?: () => string;
}

const MAX_SUGGESTIONS = 40;

/** Applies a text change to an open markdown document (merging with concurrent edits). */
export async function editNote(
  documents: DocumentsApi,
  path: VaultPath,
  edit: (text: string) => Array<{ from: number; to: number; insert: string }> | null,
): Promise<boolean> {
  const handle = await documents.open(path);
  try {
    if (handle.codec.id !== 'markdown') return false;
    const changes = edit(handle.text());
    if (!changes?.length) return false;
    const ytext = markdownText(handle.doc);
    handle.doc.transact(() => {
      // Apply from the end so earlier offsets stay valid.
      for (const c of [...changes].sort((a, b) => b.from - a.from)) {
        if (c.to > c.from) ytext.delete(c.from, c.to - c.from);
        if (c.insert) ytext.insert(c.from, c.insert);
      }
    }, 'pumice:links');
    await handle.save();
    return true;
  } finally {
    handle.dispose();
  }
}

export class LinksImpl implements LinksApi {
  private readonly sources: LinkSuggestSource[] = [];
  private readonly formatters: LinkFormatter[] = [];

  constructor(private readonly opts: LinksOptions) {}

  // -------------------------------------------------------------------------------------------
  // Link text

  async linkTo(path: VaultPath, opts: LinkFormatOptions = {}): Promise<string> {
    return this.formatLink(path, opts);
  }

  formatLink(path: VaultPath, opts: LinkFormatOptions = {}): string {
    const file = this.opts.index.getFile(path);
    if (!file) throw new Error(`'${path}' is not in the index`);
    return this.format(file, opts);
  }

  registerLinkFormatter(formatter: LinkFormatter): Disposable {
    this.formatters.push(formatter);
    return toDisposable(() => this.formatters.splice(this.formatters.indexOf(formatter) >>> 0, 1));
  }

  private format(file: IndexedFile, opts: LinkFormatOptions): string {
    for (const f of this.formatters) {
      const text = f(file, opts);
      if (text !== undefined) return text;
    }
    return formatWikiLink(
      {
        target: this.shortestName(file),
        ...(opts.subpath ? { subpath: opts.subpath } : {}),
        ...(opts.alias ? { alias: opts.alias } : {}),
      },
      { embed: !!opts.embed, inTable: !!opts.inTable },
    );
  }

  /**
   * How Obsidian writes a target: the note name (no `.md`) if no other file shares it, else the
   * vault path. Other files keep their extension.
   */
  private shortestName(file: IndexedFile): string {
    const md = /\.md$/i.test(file.path);
    const strip = (p: string) => (md ? p.replace(/\.md$/i, '') : p);
    const name = basename(file.path).toLowerCase();
    const clash = this.opts.index
      .files()
      .some((f) => f.path !== file.path && basename(f.path).toLowerCase() === name);
    return strip(clash ? file.path : basename(file.path));
  }

  displayText(link: Pick<LinkRef, 'target' | 'subpath' | 'alias'>, sourcePath: VaultPath): string {
    if (link.alias) return link.alias;
    const resolved = this.opts.index.resolve(link.target, sourcePath);
    const sub = link.subpath?.replace(/^\^/, '').replace(/#/g, ' › ');
    if (!link.target) return sub ?? '';
    // A link written by name shows as written; others (paths, plugin-resolved) show the title.
    const name =
      resolved && resolved.via !== 'name' && resolved.via !== 'alias'
        ? resolved.file.title
        : link.target.split('/').pop()!.replace(/\.md$/i, '');
    return sub ? `${name} › ${sub}` : name;
  }

  // -------------------------------------------------------------------------------------------
  // Navigation

  async openLink(
    target: string,
    opts: { sourcePath: VaultPath; subpath?: string; newTab?: boolean },
  ): Promise<void> {
    const workspace = this.opts.workspace;
    const resolved = this.opts.index.resolve(target, opts.sourcePath);
    const state = opts.subpath ? { subpath: opts.subpath } : {};
    if (resolved) {
      await workspace?.openFile(resolved.file.path, { newTab: !!opts.newTab, state });
      return;
    }
    if (!target.trim()) return;
    const path = await this.createNote(target, opts.sourcePath);
    await workspace?.openFile(path, { newTab: !!opts.newTab, state });
  }

  /** Creates the note an unresolved link points to. */
  private async createNote(target: string, sourcePath: VaultPath): Promise<VaultPath> {
    const clean = target.replace(/\.md$/i, '').trim();
    const folderSetting = this.opts.newNoteFolder?.() ?? '';
    let path: VaultPath;
    if (clean.includes('/')) path = normalizePath(`${clean}.md`);
    else {
      const folder = folderSetting === '.' ? dirname(sourcePath) : folderSetting;
      path = joinPath(folder, `${clean}.md`);
    }
    await this.opts.vault.create(path, '');
    return path;
  }

  // -------------------------------------------------------------------------------------------
  // Suggestions

  registerSuggestSource(source: LinkSuggestSource): Disposable {
    this.sources.push(source);
    return toDisposable(() => this.sources.splice(this.sources.indexOf(source) >>> 0, 1));
  }

  suggest(query: string, sourcePath: VaultPath): LinkSuggestion[] {
    return [
      ...this.builtinSuggestions(query, sourcePath),
      ...this.sources.flatMap((s) => s.suggest(query, sourcePath)),
    ];
  }

  private builtinSuggestions(query: string, sourcePath: VaultPath): LinkSuggestion[] {
    const hash = query.indexOf('#');
    if (hash >= 0)
      return this.subpathSuggestions(query.slice(0, hash), query.slice(hash + 1), sourcePath);
    const scored: Array<{ score: number; s: LinkSuggestion }> = [];
    for (const file of this.opts.index.files()) {
      const md = file.path.toLowerCase().endsWith('.md');
      const candidates: Array<{ text: string; alias?: string }> = [
        { text: md ? file.title : basename(file.path) },
      ];
      if (md && file.title !== file.name) candidates.push({ text: file.name });
      for (const alias of file.meta?.aliases ?? []) candidates.push({ text: alias, alias });
      let best: { score: number; alias?: string } | undefined;
      for (const c of candidates) {
        const m = query ? fuzzyMatch(query, c.text) : { score: 0 };
        if (m && (!best || m.score > best.score))
          best = { score: m.score + (c.alias ? -0.5 : 0), ...(c.alias ? { alias: c.alias } : {}) };
      }
      if (!best && query) {
        const m = fuzzyMatch(query, file.path);
        if (m) best = { score: m.score - 2 };
      }
      if (!best) continue;
      const alias = best.alias;
      scored.push({
        score: best.score - (file.path === sourcePath ? 5 : 0),
        s: {
          label: alias ?? (md ? file.title : basename(file.path)),
          detail: alias ? `${file.title} · ${file.path}` : file.path,
          insert: ({ embed, inTable }) =>
            this.format(file, { embed, inTable, ...(alias ? { alias } : {}) }),
        },
      });
    }
    if (!query) {
      // Recently changed notes first when nothing is typed yet.
      const byPath = new Map(this.opts.index.files().map((f) => [f.path, f.mtime]));
      scored.sort(
        (a, b) => (byPath.get(b.s.detail ?? '') ?? 0) - (byPath.get(a.s.detail ?? '') ?? 0),
      );
    } else {
      scored.sort((a, b) => b.score - a.score);
    }
    return scored.slice(0, MAX_SUGGESTIONS).map((x) => x.s);
  }

  private subpathSuggestions(
    targetText: string,
    sub: string,
    sourcePath: VaultPath,
  ): LinkSuggestion[] {
    const resolved = targetText
      ? this.opts.index.resolve(targetText, sourcePath)
      : this.opts.index.resolve('', sourcePath);
    const file = resolved?.file;
    if (!file?.meta) return [];
    const same = file.path === sourcePath;
    if (sub.startsWith('^')) {
      const q = sub.slice(1);
      return file.meta.blocks
        .filter((b) => !q || b.id.includes(q))
        .slice(0, MAX_SUGGESTIONS)
        .map((b) => ({
          label: `^${b.id}`,
          detail: same ? 'This note' : file.title,
          insert: ({ embed, inTable }) =>
            same
              ? formatWikiLink({ target: '', subpath: `^${b.id}` }, { embed, inTable })
              : this.format(file, { subpath: `^${b.id}`, embed, inTable }),
        }));
    }
    return file.meta.headings
      .map((h) => ({ h, m: sub ? fuzzyMatch(sub, h.text) : { score: 0 } }))
      .filter((x) => x.m)
      .sort((a, b) => (sub ? b.m!.score - a.m!.score : a.h.from - b.h.from))
      .slice(0, MAX_SUGGESTIONS)
      .map(({ h }) => ({
        label: `${'#'.repeat(h.level)} ${h.text}`,
        detail: same ? 'This note' : file.title,
        insert: ({ embed, inTable }) =>
          same
            ? formatWikiLink({ target: '', subpath: h.text }, { embed, inTable })
            : this.format(file, { subpath: h.text, embed, inTable }),
      }));
  }
}
