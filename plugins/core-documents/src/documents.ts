import {
  Emitter,
  basename,
  dirname,
  normalizePath,
  type Disposable,
  type DocumentCodec,
  type DocumentAttachment,
  type DocumentHandle,
  type DocumentProvider,
  type DocumentsApi,
  type VaultApi,
  type VaultChange,
  type VaultPath,
} from '@pumice/api';
import * as Y from 'yjs';

const ORIGIN_PROVIDER = 'pumice:provider-load';

export interface DocumentsOptions {
  /** Delay after the last change before writing to disk. */
  saveDelay?: number;
  /** Clock for conflict-copy names (injectable for tests). */
  now?: () => Date;
}

/** One open document, shared by all handles to the same file. */
class OpenDocument {
  readonly doc = new Y.Doc();
  refs = 0;
  /** Content last read from or written to disk (the merge base). */
  projected = '';
  deleted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes disk I/O for this document. */
  private queue: Promise<void> = Promise.resolve();
  readonly renamed = new Emitter<VaultPath>();
  readonly removed = new Emitter<void>();
  attachment: DocumentAttachment | undefined;

  constructor(
    public path: VaultPath,
    readonly codec: DocumentCodec,
    private readonly owner: DocumentsImpl,
  ) {
    this.doc.on('update', () => {
      this.scheduleSave();
      this.owner.changed.fire(this.path);
    });
  }

  run(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(task)
      .catch((e) => console.error(`[core.documents] ${this.path}:`, e));
    return this.queue;
  }

  scheduleSave(): void {
    if (this.deleted) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), this.owner.saveDelay);
  }

  save(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.run(async () => {
      if (this.deleted) return;
      // An external edit may have landed since the last reconcile (its watcher event still
      // queued): merge it first instead of overwriting it.
      const disk = await this.owner.vault.read(this.path).catch(() => undefined);
      if (disk !== undefined && disk !== this.projected) await this.mergeDisk(disk);
      const text = this.codec.serialize(this.doc, this.path);
      if (text === this.projected) return;
      // Update the base before writing: the vault's change event for our own write must not
      // be mistaken for an external edit.
      const previous = this.projected;
      this.projected = text;
      try {
        await this.owner.vault.write(this.path, text);
      } catch (e) {
        this.projected = previous;
        throw e;
      }
      this.attachment?.saved?.(text);
    });
  }

  /** Merges an external change of the file into the document. */
  reconcile(): Promise<void> {
    return this.run(async () => {
      if (this.deleted) return;
      const disk = await this.owner.vault.read(this.path);
      if (disk === this.projected) return;
      await this.mergeDisk(disk);
      // The merged content may differ from disk (we had unsaved changes): write it back.
      if (this.codec.serialize(this.doc, this.path) !== disk) this.scheduleSave();
    });
  }

  async mergeDisk(disk: string): Promise<void> {
    const base = this.projected;
    this.projected = disk;
    if (!this.codec.mergeExternal(this.doc, base, disk, this.path)) {
      await this.owner.saveConflictCopy(this.path, disk);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.attachment?.dispose();
    this.doc.destroy();
    this.renamed.dispose();
    this.removed.dispose();
  }
}

export class DocumentsImpl implements DocumentsApi, Disposable {
  private readonly open_ = new Map<VaultPath, OpenDocument>();
  private readonly opening = new Map<VaultPath, Promise<OpenDocument>>();
  private readonly codecs: DocumentCodec[] = [];
  private readonly providers: DocumentProvider[] = [];
  private readonly subscription: Disposable;
  readonly saveDelay: number;
  private readonly now: () => Date;
  readonly changed = new Emitter<VaultPath>();
  readonly onDidChange = this.changed.event;

  constructor(
    readonly vault: VaultApi,
    options: DocumentsOptions = {},
  ) {
    this.saveDelay = options.saveDelay ?? 1000;
    this.now = options.now ?? (() => new Date());
    this.subscription = vault.onDidChange((changes) => this.onVaultChange(changes));
  }

  registerCodec(codec: DocumentCodec): Disposable {
    this.codecs.push(codec);
    return { dispose: () => this.codecs.splice(this.codecs.indexOf(codec) >>> 0, 1) };
  }

  registerProvider(provider: DocumentProvider): Disposable {
    this.providers.push(provider);
    // Documents opened before the provider existed join it now.
    for (const doc of this.open_.values()) {
      if (!doc.attachment && provider.handles(doc.path))
        doc.attachment = provider.attach(doc.doc, () => doc.path);
    }
    return { dispose: () => this.providers.splice(this.providers.indexOf(provider) >>> 0, 1) };
  }

  codecFor(path: VaultPath): DocumentCodec | undefined {
    const name = basename(path).toLowerCase();
    let best: { codec: DocumentCodec; length: number } | undefined;
    for (const codec of this.codecs) {
      for (const ext of codec.extensions) {
        if (name.endsWith(`.${ext}`) && (!best || ext.length > best.length))
          best = { codec, length: ext.length };
      }
    }
    return best?.codec;
  }

  peek(path: VaultPath): string | undefined {
    const doc = this.open_.get(normalizePath(path));
    return doc ? doc.codec.serialize(doc.doc, doc.path) : undefined;
  }

  async read(path: VaultPath): Promise<string> {
    return this.peek(path) ?? this.vault.read(path);
  }

  isOpen(path: VaultPath): boolean {
    return this.open_.has(normalizePath(path));
  }

  async open(path: VaultPath): Promise<DocumentHandle> {
    const p = normalizePath(path);
    let doc = this.open_.get(p);
    if (!doc) {
      let pending = this.opening.get(p);
      if (!pending) {
        pending = this.load(p).finally(() => this.opening.delete(p));
        this.opening.set(p, pending);
      }
      doc = await pending;
    }
    doc.refs++;
    return this.handle(doc);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.open_.values()].map((d) => d.save()));
  }

  /** Resolves when all pending disk I/O of open documents is done (for tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.open_.values()].map((d) => d.run(async () => undefined)));
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
    for (const doc of this.open_.values()) doc.dispose();
    this.open_.clear();
  }

  async saveConflictCopy(path: VaultPath, content: string): Promise<void> {
    const name = basename(path);
    const dot = name.indexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot + 1) : '';
    const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
    const target = this.vault.availablePath(dirname(path), `${stem} (conflict ${stamp})`, ext);
    await this.vault.create(target, content);
  }

  private async load(path: VaultPath): Promise<OpenDocument> {
    const codec = this.codecFor(path);
    if (!codec) throw new Error(`No document codec for '${path}'`);
    const content = await this.vault.read(path);
    const doc = new OpenDocument(path, codec, this);
    const provider = this.providers.find((p) => p.handles(path));
    const loaded = await provider?.load(path);
    if (loaded) {
      // Shared history comes from the provider; the file is reconciled against what was last
      // written from that state.
      Y.applyUpdate(doc.doc, loaded.state, ORIGIN_PROVIDER);
      doc.projected = loaded.projected;
    } else {
      codec.load(doc.doc, content, path);
      doc.projected = content;
    }
    if (provider) doc.attachment = provider.attach(doc.doc, () => doc.path);
    this.open_.set(path, doc);
    if (loaded && content !== loaded.projected) await doc.run(() => doc.mergeDisk(content));
    return doc;
  }

  private handle(doc: OpenDocument): DocumentHandle {
    let released = false;
    return {
      doc: doc.doc,
      codec: doc.codec,
      get path() {
        return doc.path;
      },
      get awareness() {
        return doc.attachment?.awareness;
      },
      get readOnly() {
        return !!doc.attachment?.readOnly;
      },
      onDidRename: doc.renamed.event,
      onDidDelete: doc.removed.event,
      text: () => doc.codec.serialize(doc.doc, doc.path),
      save: () => doc.save(),
      dispose: () => {
        if (released) return;
        released = true;
        if (--doc.refs > 0) return;
        void doc.save().finally(() => {
          // Re-opened while saving: keep it.
          if (doc.refs > 0) return;
          if (this.open_.get(doc.path) === doc) this.open_.delete(doc.path);
          doc.dispose();
        });
      },
    };
  }

  private onVaultChange(changes: VaultChange[]): void {
    for (const change of changes) {
      if (change.type === 'rename') {
        const doc = this.open_.get(change.oldPath);
        if (!doc) continue;
        this.open_.delete(change.oldPath);
        doc.path = change.entry.path;
        this.open_.set(doc.path, doc);
        doc.renamed.fire(doc.path);
      } else if (change.type === 'delete') {
        const doc = this.open_.get(change.path);
        if (!doc) continue;
        doc.deleted = true;
        doc.removed.fire();
      } else if (change.type === 'create' || change.type === 'modify') {
        const doc = this.open_.get(change.entry.path);
        if (!doc) continue;
        if (doc.deleted && change.type === 'create') doc.deleted = false;
        if (change.external) void doc.reconcile();
      }
    }
  }
}
