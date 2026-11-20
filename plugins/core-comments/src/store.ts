import {
  Emitter,
  type CommentEntry,
  type CommentThread,
  type CommentsApi,
  type DocumentsApi,
  type LocatedThread,
  type MetadataIndexApi,
  type PlatformFs,
  type VaultPath,
} from '@pumice/api';
import { createAnchor, resolveAnchor } from './anchor';

interface CommentsFile {
  version: 1;
  /** Vault path of the note (the sidecar sits at the same path under `.pumice/comments`). */
  path: VaultPath;
  threads: CommentThread[];
}

export const COMMENTS_DIR = '.pumice/comments';

const newId = () =>
  Date.now().toString(36) +
  Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');

export interface StoreDeps {
  fs: PlatformFs;
  index: MetadataIndexApi;
  documents: DocumentsApi;
  author(): string;
}

/**
 * Comment threads per note, in `.pumice/comments/<note path>.json` (docs/plan/09, D16). The
 * sidecar follows the note when it is renamed or moved in the app.
 */
export class CommentStore implements CommentsApi {
  private readonly cache = new Map<string, CommentsFile>();
  private readonly changed = new Emitter<VaultPath>();
  readonly onDidChange = this.changed.event;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StoreDeps) {}

  dispose(): void {
    this.changed.dispose();
  }

  private fileOf(path: VaultPath): VaultPath {
    return `${COMMENTS_DIR}/${path}.json`;
  }

  /** A note (or folder) was renamed: move its comments along. */
  async moved(oldPath: VaultPath, newPath: VaultPath, kind: 'file' | 'folder'): Promise<void> {
    const from = kind === 'file' ? this.fileOf(oldPath) : `${COMMENTS_DIR}/${oldPath}`;
    const to = kind === 'file' ? this.fileOf(newPath) : `${COMMENTS_DIR}/${newPath}`;
    const run = async () => {
      this.cache.clear();
      try {
        if (await this.deps.fs.stat(from)) await this.deps.fs.rename(from, to);
      } catch {
        // The comments stay under the old path; nothing else is lost.
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    await next;
    this.changed.fire(newPath);
  }

  private async load(path: VaultPath): Promise<CommentsFile> {
    const id = path;
    const cached = this.cache.get(id);
    if (cached) return cached;
    let file: CommentsFile = { version: 1, path, threads: [] };
    try {
      if (await this.deps.fs.stat(this.fileOf(id))) {
        const parsed = JSON.parse(await this.deps.fs.readText(this.fileOf(id))) as CommentsFile;
        if (Array.isArray(parsed.threads)) file = { ...parsed, path };
      }
    } catch {
      // Unreadable file: start empty rather than failing the editor; the file is left alone
      // until the next write.
    }
    this.cache.set(id, file);
    return file;
  }

  /** Serializes read-modify-write cycles. */
  private mutate<T>(path: VaultPath, fn: (file: CommentsFile, text: string) => T): Promise<T> {
    const run = async () => {
      if (!this.deps.index.getFile(path)) throw new Error(`'${path}' is not a note in this vault.`);
      const id = path;
      const file = await this.load(path);
      const text = await this.deps.documents.read(path);
      const before = JSON.stringify(file.threads);
      const result = fn(file, text);
      if (JSON.stringify(file.threads) === before && file.path === path) return result;
      file.path = path;
      if (file.threads.length) {
        await this.deps.fs.write(this.fileOf(id), `${JSON.stringify(file, null, 2)}\n`);
      } else if (await this.deps.fs.stat(this.fileOf(id))) {
        await this.deps.fs.remove(this.fileOf(id));
      }
      this.changed.fire(path);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private thread(file: CommentsFile, threadId: string): CommentThread {
    const t = file.threads.find((x) => x.id === threadId);
    if (!t) throw new Error('This comment thread no longer exists.');
    return t;
  }

  async threads(path: VaultPath): Promise<LocatedThread[]> {
    if (!this.deps.index.getFile(path)) return [];
    const file = await this.load(path);
    if (!file.threads.length) return [];
    const text = this.deps.documents.peek(path) ?? (await this.deps.documents.read(path));
    const located = file.threads.map((t) => ({ ...t, range: resolveAnchor(text, t.anchor) }));
    return located.sort((a, b) =>
      a.range && b.range ? a.range.from - b.range.from : a.range ? -1 : b.range ? 1 : 0,
    );
  }

  addThread(
    path: VaultPath,
    range: { from: number; to: number },
    body: string,
    author = this.deps.author(),
  ): Promise<CommentThread> {
    return this.mutate(path, (file, text) => {
      const thread: CommentThread = {
        id: newId(),
        anchor: createAnchor(text, range.from, range.to),
        resolved: false,
        comments: [{ id: newId(), author, body, created: new Date().toISOString() }],
      };
      file.threads.push(thread);
      return thread;
    });
  }

  reply(path: VaultPath, threadId: string, body: string, author = this.deps.author()) {
    return this.mutate(path, (file) => {
      const c: CommentEntry = { id: newId(), author, body, created: new Date().toISOString() };
      this.thread(file, threadId).comments.push(c);
      return c;
    });
  }

  editComment(path: VaultPath, threadId: string, commentId: string, body: string) {
    return this.mutate(path, (file) => {
      const c = this.thread(file, threadId).comments.find((x) => x.id === commentId);
      if (!c) throw new Error('This comment no longer exists.');
      c.body = body;
      c.edited = new Date().toISOString();
    });
  }

  deleteComment(path: VaultPath, threadId: string, commentId: string) {
    return this.mutate(path, (file) => {
      const t = this.thread(file, threadId);
      t.comments = t.comments.filter((c) => c.id !== commentId);
      // The last comment takes the thread with it.
      if (!t.comments.length) file.threads = file.threads.filter((x) => x !== t);
    });
  }

  setResolved(path: VaultPath, threadId: string, resolved: boolean) {
    return this.mutate(path, (file) => {
      this.thread(file, threadId).resolved = resolved;
    });
  }

  deleteThread(path: VaultPath, threadId: string) {
    return this.mutate(path, (file) => {
      file.threads = file.threads.filter((t) => t.id !== threadId);
    });
  }

  /**
   * Records where threads are now (from an open editor, which tracks them through edits), so
   * the saved anchors stay accurate. Writes only when something moved or changed.
   */
  updateRanges(path: VaultPath, ranges: Map<string, { from: number; to: number }>, text: string) {
    if (!this.cache.get(path)?.threads.length) return Promise.resolve();
    return this.mutate(path, (file) => {
      for (const t of file.threads) {
        const r = ranges.get(t.id);
        if (!r) continue;
        const next = createAnchor(text, r.from, r.to);
        if (next.exact || r.from === r.to) t.anchor = next;
      }
    });
  }

  /** Forgets cached files (external change to `.pumice/comments`). */
  invalidate(): void {
    this.cache.clear();
  }
}
