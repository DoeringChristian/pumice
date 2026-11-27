import {
  MANIFEST_DOC,
  MessageKind,
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
  type Envelope,
  type ManifestFile,
  type PublicUser,
  type Role,
} from '@pumice/collab-protocol';
import {
  Emitter,
  basename,
  dirname,
  joinPath,
  type DocumentAttachment,
  type DocumentProvider,
  type DocumentsApi,
  type PluginStorage,
  type VaultApi,
  type VaultChange,
  type VaultPath,
} from '@pumice/api';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { CollabClient } from './client';

/** Transaction origins. */
const REMOTE = 'pumice:collab-remote';
const BRIDGE = 'pumice:collab-bridge';
const STORAGE_DELAY = 400;

export function kindOf(path: string): ManifestFile['kind'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.excalidraw.md') || lower.endsWith('.excalidraw')) return 'drawing';
  if (lower.endsWith('.md')) return 'note';
  return 'attachment';
}

const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes]
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 16);
};

function withSuffix(path: string, n: number): string {
  const name = basename(path);
  const dot = name.indexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return joinPath(dirname(path), `${stem} (${n})${ext}`);
}

export interface Presence {
  clientId: number;
  user: { name: string; color: string };
  file?: string;
}

export interface SharedVaultOptions {
  client: CollabClient;
  vaultId: string;
  user: PublicUser;
  role: Role;
  vault: VaultApi;
  documents: DocumentsApi;
  storage: PluginStorage;
  notify?(message: string, kind?: 'info' | 'warning' | 'error'): void;
}

/**
 * One local vault linked to a shared vault on the server: a full replica (manifest + every
 * note/drawing as a Y.Doc + attachments as blobs), kept in sync with the server and projected to
 * the files on disk in both directions (docs/plan/05).
 */
export class SharedVault {
  readonly manifest = new Y.Doc();
  readonly files = this.manifest.getMap<ManifestFile>('files');
  private readonly replicas = new Map<string, Y.Doc>();
  private readonly synced = new Set<string>();
  /** fileId → text last written to / read from disk for the replica's state. */
  private readonly projected = new Map<string, string>();
  /** Local path → fileId of files on disk that belong to the manifest. */
  private readonly local = new Map<VaultPath, string>();
  /** Paths we are writing ourselves (their vault events are not user changes). */
  private readonly ownWrites = new Map<VaultPath, number>();
  private readonly blobHashes = new Map<VaultPath, string>();
  private readonly pendingBlobs = new Set<string>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly docAwareness = new Map<string, awarenessProtocol.Awareness>();
  readonly awareness = new awarenessProtocol.Awareness(this.manifest);
  private readonly presenceChanged = new Emitter<Presence[]>();
  readonly onDidChangePresence = this.presenceChanged.event;
  private readonly disposers: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  role: Role;

  constructor(private readonly opts: SharedVaultOptions) {
    this.role = opts.role;
  }

  get vaultId(): string {
    return this.opts.vaultId;
  }

  get readOnly(): boolean {
    return this.role === 'viewer';
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  /** Loads the local replica, reconciles offline changes on disk and connects. */
  async start(opts: { seedFromDisk?: boolean } = {}): Promise<void> {
    await this.init();
    await this.run(opts);
  }

  /** Local part of starting (no disk scan, no network): after it, the provider can be used. */
  async init(): Promise<void> {
    await this.loadPersisted();
    this.observeManifest();
    this.disposers.push(
      this.opts.vault.onDidChange((changes) => this.enqueue(() => this.onVaultChange(changes)))
        .dispose,
    );
    this.disposers.push(this.opts.client.onMessage((env) => this.onMessage(env)).dispose);
    this.disposers.push(this.opts.client.onOpen(() => this.syncAll()).dispose);
    this.disposers.push(
      this.opts.client.onControl(({ vault, message }) => {
        if (vault === this.opts.vaultId && message.type === 'readonly') this.role = 'viewer';
      }).dispose,
    );
    this.awareness.setLocalStateField('user', {
      name: this.opts.user.name,
      color: this.opts.user.color,
    });
    const onAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin !== REMOTE) {
        const changed = [...added, ...updated, ...removed];
        this.opts.client.send(
          MessageKind.Awareness,
          this.opts.vaultId,
          MANIFEST_DOC,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
      }
      this.presenceChanged.fire(this.presence());
    };
    this.awareness.on('update', onAwareness);
    this.disposers.push(() => this.awareness.off('update', onAwareness));
  }

  /** Reconciles the folder with the replica (changes made while closed) and syncs. */
  async run(opts: { seedFromDisk?: boolean } = {}): Promise<void> {
    await this.enqueue(() => this.reconcileDisk(!!opts.seedFromDisk));
    if (this.opts.client.state === 'online') this.syncAll();
  }

  dispose(): void {
    this.disposed = true;
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.manifest.clientID], 'dispose');
    for (const d of this.disposers) d();
    for (const t of this.saveTimers.values()) clearTimeout(t);
    for (const a of this.docAwareness.values()) a.destroy();
    for (const doc of this.replicas.values()) doc.destroy();
    this.manifest.destroy();
    this.presenceChanged.dispose();
  }

  /** Waits until queued disk work is done (tests, before quitting). */
  async idle(): Promise<void> {
    await this.queue;
  }

  private enqueue(task: () => Promise<void> | void): Promise<void> {
    this.queue = this.queue.then(task).catch((e) => console.error('[core.collab]', e));
    return this.queue;
  }

  presence(): Presence[] {
    const out: Presence[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.manifest.clientID || !state.user) continue;
      out.push({
        clientId,
        user: state.user as Presence['user'],
        ...(state.file ? { file: state.file as string } : {}),
      });
    }
    return out;
  }

  setActiveFile(path: VaultPath | undefined): void {
    const id = path ? this.local.get(path) : undefined;
    this.awareness.setLocalStateField('file', id ? this.files.get(id)?.path : undefined);
  }

  /** fileId of a local path in this shared vault. */
  idOf(path: VaultPath): string | undefined {
    return this.local.get(path);
  }

  // ---------------------------------------------------------------------------------------------
  // Persistence (app storage, outside the vault)

  private key(kind: string, id = ''): string {
    return `v:${this.opts.vaultId}:${kind}${id ? `:${id}` : ''}`;
  }

  private async loadPersisted(): Promise<void> {
    const s = this.opts.storage;
    const manifest = await s.get(this.key('manifest'));
    if (manifest) Y.applyUpdate(this.manifest, base64ToBytes(manifest), 'load');
    const index = JSON.parse((await s.get(this.key('index'))) ?? '{}') as {
      local?: Record<string, string>;
      synced?: string[];
      pendingBlobs?: string[];
    };
    for (const [path, id] of Object.entries(index.local ?? {})) this.local.set(path, id);
    for (const id of index.synced ?? []) this.synced.add(id);
    for (const id of index.pendingBlobs ?? []) this.pendingBlobs.add(id);
    for (const [id, entry] of this.files) {
      if (entry.kind === 'attachment') continue;
      const state = await s.get(this.key('doc', id));
      const doc = this.replica(id, false);
      if (state) Y.applyUpdate(doc, base64ToBytes(state), 'load');
      const proj = await s.get(this.key('proj', id));
      if (proj !== undefined) this.projected.set(id, proj);
    }
    this.manifest.on('update', (update: Uint8Array, origin: unknown) => {
      this.persistSoon('manifest');
      if (origin === REMOTE || origin === 'load' || this.readOnly) return;
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this.opts.client.send(
        MessageKind.Sync,
        this.opts.vaultId,
        MANIFEST_DOC,
        encoding.toUint8Array(enc),
      );
    });
  }

  private persistSoon(what: string): void {
    clearTimeout(this.saveTimers.get(what));
    this.saveTimers.set(
      what,
      setTimeout(() => {
        this.saveTimers.delete(what);
        void this.persistNow(what);
      }, STORAGE_DELAY),
    );
  }

  private async persistNow(what: string): Promise<void> {
    if (this.disposed) return;
    const s = this.opts.storage;
    if (what === 'manifest')
      await s.set(this.key('manifest'), bytesToBase64(Y.encodeStateAsUpdate(this.manifest)));
    else if (what === 'index') {
      await s.set(
        this.key('index'),
        JSON.stringify({
          local: Object.fromEntries(this.local),
          synced: [...this.synced],
          pendingBlobs: [...this.pendingBlobs],
        }),
      );
    } else if (what.startsWith('doc:')) {
      const id = what.slice(4);
      const doc = this.replicas.get(id);
      if (doc) await s.set(this.key('doc', id), bytesToBase64(Y.encodeStateAsUpdate(doc)));
      const proj = this.projected.get(id);
      if (proj !== undefined) await s.set(this.key('proj', id), proj);
    }
  }

  /** Writes everything now (before quitting). */
  async flush(): Promise<void> {
    const pending = [...this.saveTimers.keys()];
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
    await Promise.all([...pending, 'index'].map((w) => this.persistNow(w)));
  }

  // ---------------------------------------------------------------------------------------------
  // Replicas

  private replica(id: string, create = true): Y.Doc {
    let doc = this.replicas.get(id);
    if (doc) return doc;
    doc = new Y.Doc({ guid: id });
    this.replicas.set(id, doc);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.persistSoon(`doc:${id}`);
      if (origin === 'load') return;
      if (origin !== REMOTE && !this.readOnly) {
        const enc = encoding.createEncoder();
        syncProtocol.writeUpdate(enc, update);
        this.opts.client.send(MessageKind.Sync, this.opts.vaultId, id, encoding.toUint8Array(enc));
      }
      if (origin === REMOTE) void this.enqueue(() => this.project(id));
    });
    if (create && this.opts.client.state === 'online') this.syncDoc(id, doc);
    return doc;
  }

  private syncDoc(name: string, doc: Y.Doc): void {
    const enc = encoding.createEncoder();
    syncProtocol.writeSyncStep1(enc, doc);
    this.opts.client.send(MessageKind.Sync, this.opts.vaultId, name, encoding.toUint8Array(enc));
  }

  private syncAll(): void {
    this.syncDoc(MANIFEST_DOC, this.manifest);
    for (const [id, doc] of this.replicas) this.syncDoc(id, doc);
    const state = this.awareness.getLocalState();
    if (state)
      this.opts.client.send(
        MessageKind.Awareness,
        this.opts.vaultId,
        MANIFEST_DOC,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.manifest.clientID]),
      );
    for (const [id, a] of this.docAwareness) {
      this.opts.client.send(
        MessageKind.Awareness,
        this.opts.vaultId,
        id,
        awarenessProtocol.encodeAwarenessUpdate(a, [a.clientID]),
      );
    }
    void this.enqueue(() => this.uploadPendingBlobs());
  }

  private onMessage(env: Envelope): void {
    if (env.vault !== this.opts.vaultId) return;
    if (env.kind === MessageKind.Awareness) {
      const target = env.doc === MANIFEST_DOC ? this.awareness : this.docAwareness.get(env.doc);
      if (target) awarenessProtocol.applyAwarenessUpdate(target, env.payload, REMOTE);
      return;
    }
    const isManifest = env.doc === MANIFEST_DOC;
    const doc = isManifest ? this.manifest : this.replica(env.doc, false);
    const decoder = decoding.createDecoder(env.payload);
    const type = decoding.peekVarUint(decoder);
    const encoder = encoding.createEncoder();
    syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
    if (encoding.length(encoder) > 0)
      this.opts.client.send(
        MessageKind.Sync,
        this.opts.vaultId,
        env.doc,
        encoding.toUint8Array(encoder),
      );
    if (type === syncProtocol.messageYjsSyncStep2 && !isManifest && !this.synced.has(env.doc)) {
      this.synced.add(env.doc);
      this.persistSoon('index');
      void this.enqueue(() => this.project(env.doc));
    }
    if (isManifest && type === syncProtocol.messageYjsSyncStep2) {
      // A fresh join: ask for every document the manifest lists.
      for (const [id, entry] of this.files)
        if (entry.kind !== 'attachment' && !this.replicas.has(id)) this.replica(id);
      void this.enqueue(() => this.projectAll());
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Manifest

  private observeManifest(): void {
    const onChange = (event: Y.YMapEvent<ManifestFile>, tr: Y.Transaction) => {
      if (tr.origin !== REMOTE) return;
      const ids = [...event.keysChanged];
      void this.enqueue(async () => {
        for (const id of ids) await this.applyEntry(id);
      });
    };
    this.files.observe(onChange);
    this.disposers.push(() => this.files.unobserve(onChange));
  }

  /** The path a file has locally: its manifest path, made unique among live entries. */
  effectivePath(id: string): VaultPath | undefined {
    const entry = this.files.get(id);
    if (!entry || entry.deleted) return undefined;
    const lower = entry.path.toLowerCase();
    const same = [...this.files.entries()]
      .filter(([, e]) => !e.deleted && e.path.toLowerCase() === lower)
      .sort(([a, x], [b, y]) => x.created - y.created || (a < b ? -1 : 1))
      .map(([i]) => i);
    const n = same.indexOf(id);
    return n <= 0 ? entry.path : withSuffix(entry.path, n + 1);
  }

  private localPathOf(id: string): VaultPath | undefined {
    for (const [path, fid] of this.local) if (fid === id) return path;
    return undefined;
  }

  private setLocal(path: VaultPath, id: string | undefined): void {
    if (id === undefined) this.local.delete(path);
    else this.local.set(path, id);
    this.persistSoon('index');
  }

  private async own<T>(path: VaultPath, task: () => Promise<T>): Promise<T> {
    this.ownWrites.set(path, (this.ownWrites.get(path) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const n = (this.ownWrites.get(path) ?? 1) - 1;
      if (n <= 0) this.ownWrites.delete(path);
      else this.ownWrites.set(path, n);
    }
  }

  /** Brings the local file of one manifest entry in line with the manifest. */
  private async applyEntry(id: string): Promise<void> {
    const entry = this.files.get(id);
    const current = this.localPathOf(id);
    if (!entry || entry.deleted) {
      if (current && this.opts.vault.get(current)) {
        await this.own(current, () => this.opts.vault.delete(current)).catch(() => undefined);
      }
      if (current) this.setLocal(current, undefined);
      return;
    }
    const target = this.effectivePath(id)!;
    if (current && current !== target && this.opts.vault.get(current)) {
      if (!this.opts.vault.get(target)) {
        await this.own(current, () =>
          this.own(target, () => this.opts.vault.rename(current, target)),
        );
        this.setLocal(current, undefined);
        this.setLocal(target, id);
      }
    }
    if (entry.kind === 'attachment') await this.ensureBlob(id);
    else await this.project(id);
  }

  private async projectAll(): Promise<void> {
    for (const [id] of this.files) await this.applyEntry(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Projection: replica → file

  private async project(id: string): Promise<void> {
    if (this.disposed) return;
    const entry = this.files.get(id);
    if (!entry || entry.deleted || entry.kind === 'attachment') return;
    const path = this.localPathOf(id) ?? this.effectivePath(id)!;
    const doc = this.replicas.get(id);
    if (!doc) return;
    // Don't create a file before we've heard from the server (it may still be loading).
    if (!this.synced.has(id) && !this.projected.has(id) && !this.opts.vault.get(path)) return;
    // Open documents are written by core.documents (the bridge keeps them in sync).
    if (this.opts.documents.isOpen(path)) return;
    const codec = this.opts.documents.codecFor(path);
    if (!codec) return;
    const text = codec.serialize(doc, path);
    const existing = this.opts.vault.get(path);
    if (!existing) {
      if (this.opts.vault.get(path) === undefined) {
        await this.own(path, () => this.opts.vault.create(path, text));
        this.setLocal(path, id);
        this.projected.set(id, text);
        this.persistSoon(`doc:${id}`);
      }
      return;
    }
    this.setLocal(path, id);
    const disk = await this.opts.vault.read(path);
    const base = this.projected.get(id);
    if (disk === text) {
      this.projected.set(id, text);
      return;
    }
    if (base !== undefined && disk !== base && !this.readOnly) {
      // Changed on disk since our last write: merge it into the replica first. (Viewers can't
      // change shared notes: their file is reset to the shared content.)
      codec.mergeExternal(doc, base, disk, path);
    }
    const merged = codec.serialize(doc, path);
    if (merged !== disk) await this.own(path, () => this.opts.vault.write(path, merged));
    this.projected.set(id, merged);
    this.persistSoon(`doc:${id}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Local changes → manifest and replicas

  private newEntry(path: VaultPath): string {
    const id = randomId();
    this.files.set(id, {
      path,
      kind: kindOf(path),
      created: Date.now(),
      createdBy: this.opts.user.id,
    });
    this.setLocal(path, id);
    return id;
  }

  /** Adds or merges a local file into the replica. */
  private async ingest(path: VaultPath, created: boolean): Promise<void> {
    if (this.readOnly) return;
    let id = this.local.get(path);
    if (!id) {
      if (!created && !this.opts.vault.get(path)) return;
      id = this.newEntry(path);
    }
    const entry = this.files.get(id);
    if (!entry) return;
    if (entry.kind === 'attachment') {
      await this.uploadBlob(id, path);
      return;
    }
    if (this.opts.documents.isOpen(path)) return;
    const codec = this.opts.documents.codecFor(path);
    if (!codec) return;
    const disk = await this.opts.vault.read(path);
    const doc = this.replica(id);
    const base = this.projected.get(id);
    if (base === disk) return;
    if (base === undefined && doc.share.size === 0) codec.load(doc, disk, path);
    else codec.mergeExternal(doc, base ?? codec.serialize(doc, path), disk, path);
    const merged = codec.serialize(doc, path);
    if (merged !== disk) await this.own(path, () => this.opts.vault.write(path, merged));
    this.projected.set(id, merged);
    this.synced.add(id);
    this.persistSoon(`doc:${id}`);
    this.persistSoon('index');
  }

  private async onVaultChange(changes: VaultChange[]): Promise<void> {
    for (const change of changes) {
      const path =
        change.type === 'rename'
          ? change.entry.path
          : change.type === 'delete'
            ? change.path
            : change.entry.path;
      if (
        this.ownWrites.has(path) ||
        (change.type === 'rename' && this.ownWrites.has(change.oldPath))
      )
        continue;
      if (change.type === 'create' || change.type === 'modify') {
        if (change.entry.kind !== 'file') continue;
        await this.ingest(change.entry.path, change.type === 'create');
      } else if (change.type === 'rename') {
        if (change.entry.kind !== 'file') continue;
        const id = this.local.get(change.oldPath);
        this.setLocal(change.oldPath, undefined);
        if (!id) {
          await this.ingest(change.entry.path, true);
          continue;
        }
        this.setLocal(change.entry.path, id);
        const entry = this.files.get(id);
        if (entry && !this.readOnly)
          this.files.set(id, {
            ...entry,
            path: change.entry.path,
            kind: kindOf(change.entry.path),
          });
      } else if (change.type === 'delete') {
        // Deleting a folder reports each file too; files only.
        const id = this.local.get(change.path);
        if (!id) continue;
        this.setLocal(change.path, undefined);
        const entry = this.files.get(id);
        if (entry && !entry.deleted && !this.readOnly)
          this.files.set(id, { ...entry, deleted: Date.now() });
      }
    }
  }

  /** Startup: compare the folder with the replica (changes made while the app was closed). */
  private async reconcileDisk(seed: boolean): Promise<void> {
    const onDisk = new Set(this.opts.vault.files().map((f) => f.path));
    // Files of the manifest missing on disk: deleted offline, or not projected yet.
    for (const [path, id] of [...this.local]) {
      if (onDisk.has(path)) continue;
      this.setLocal(path, undefined);
      const entry = this.files.get(id);
      if (entry && !entry.deleted && !this.readOnly)
        this.files.set(id, { ...entry, deleted: Date.now() });
    }
    for (const path of onDisk) {
      if (!this.local.has(path)) {
        // A file whose manifest path matches (e.g. first projection interrupted) adopts that entry.
        const match = [...this.files.entries()].find(
          ([id, e]) => !e.deleted && this.effectivePath(id) === path,
        );
        if (match) this.setLocal(path, match[0]);
        else if (!seed && this.files.size === 0) continue;
      }
      await this.ingest(path, true);
    }
    await this.projectAll();
  }

  // ---------------------------------------------------------------------------------------------
  // Attachments

  /** How often the download of an attachment was tried again. */
  private readonly blobRetries = new Map<string, number>();

  private async uploadBlob(id: string, path: VaultPath): Promise<void> {
    const bytes = await this.opts.vault.readBinary(path);
    const hash = await sha256Hex(bytes);
    this.blobHashes.set(path, hash);
    if (!this.files.get(id)) return;
    try {
      await this.opts.client.uploadBlob(this.opts.vaultId, hash, bytes);
      this.pendingBlobs.delete(id);
    } catch {
      // Not announced until it is on the server (see below); tried again on reconnect.
      this.pendingBlobs.add(id);
      this.persistSoon('index');
      return;
    }
    // Only now do the others learn of it: told earlier, they would ask the server for a file
    // it does not have yet.
    const entry = this.files.get(id);
    if (entry && entry.blob !== hash)
      this.files.set(id, { ...entry, blob: hash, size: bytes.length });
    this.persistSoon('index');
  }

  private async uploadPendingBlobs(): Promise<void> {
    for (const id of [...this.pendingBlobs]) {
      const path = this.localPathOf(id);
      if (path && this.opts.vault.get(path)) await this.uploadBlob(id, path);
      else this.pendingBlobs.delete(id);
    }
  }

  private async ensureBlob(id: string): Promise<void> {
    const entry = this.files.get(id);
    if (!entry?.blob || entry.deleted) return;
    const path = this.localPathOf(id) ?? this.effectivePath(id)!;
    if (this.opts.vault.get(path)) {
      let hash = this.blobHashes.get(path);
      if (!hash) {
        hash = await sha256Hex(await this.opts.vault.readBinary(path));
        this.blobHashes.set(path, hash);
      }
      if (hash === entry.blob) {
        this.setLocal(path, id);
        return;
      }
    }
    let data: Uint8Array;
    try {
      data = await this.opts.client.downloadBlob(this.opts.vaultId, entry.blob);
    } catch {
      // Tried again on the next manifest change or reconnect, and a few times by itself (the
      // server may be a moment behind).
      const tries = (this.blobRetries.get(id) ?? 0) + 1;
      if (tries <= 5) {
        this.blobRetries.set(id, tries);
        setTimeout(() => void this.ensureBlob(id).catch(() => undefined), 500 * tries);
      }
      return;
    }
    this.blobRetries.delete(id);
    await this.own(path, () => this.opts.vault.write(path, data));
    this.blobHashes.set(path, entry.blob);
    this.setLocal(path, id);
  }

  // ---------------------------------------------------------------------------------------------
  // Document provider: open documents share history with the replica

  provider(): DocumentProvider {
    return {
      id: 'collab',
      handles: (path) =>
        kindOf(path) !== 'attachment' && (this.local.has(path) || !!this.opts.vault.get(path)),
      load: async (path) => {
        const id = this.local.get(path);
        const doc = id ? this.replicas.get(id) : undefined;
        if (!id || !doc || doc.share.size === 0) return undefined;
        const projected = this.projected.get(id) ?? (await this.opts.vault.read(path));
        return { state: Y.encodeStateAsUpdate(doc), projected };
      },
      attach: (doc, pathOf) => this.attach(doc, pathOf),
    };
  }

  private attach(open: Y.Doc, pathOf: () => VaultPath): DocumentAttachment {
    let id = this.local.get(pathOf());
    if (!id && !this.readOnly) id = this.newEntry(pathOf());
    if (!id) return { dispose() {}, readOnly: this.readOnly };
    const fileId = id;
    const replica = this.replica(fileId);
    // Bridging two documents with unrelated histories would duplicate their content. That only
    // happens for a doc opened before this vault's replica was loaded; it syncs when reopened.
    const ours = Y.decodeStateVector(Y.encodeStateVector(open));
    const theirs = Y.decodeStateVector(Y.encodeStateVector(replica));
    if (ours.size && theirs.size && ![...ours.keys()].some((client) => theirs.has(client))) {
      console.warn(
        `[core.collab] ${pathOf()} was opened before collaboration started; reopen it to sync.`,
      );
      return { dispose() {}, readOnly: this.readOnly };
    }
    // Initial exchange of what each side is missing.
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(open, Y.encodeStateVector(replica)), BRIDGE);
    Y.applyUpdate(open, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(open)), BRIDGE);
    const toReplica = (u: Uint8Array, origin: unknown) =>
      origin !== BRIDGE && Y.applyUpdate(replica, u, BRIDGE);
    const toOpen = (u: Uint8Array, origin: unknown) =>
      origin !== BRIDGE && Y.applyUpdate(open, u, BRIDGE);
    open.on('update', toReplica);
    replica.on('update', toOpen);

    // Cursors and selections of collaborators in this document.
    const awareness = new awarenessProtocol.Awareness(open);
    awareness.setLocalStateField('user', {
      name: this.opts.user.name,
      color: this.opts.user.color,
      colorLight: `${this.opts.user.color}33`,
    });
    this.docAwareness.set(fileId, awareness);
    const onAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === REMOTE) return;
      this.opts.client.send(
        MessageKind.Awareness,
        this.opts.vaultId,
        fileId,
        awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
      );
    };
    awareness.on('update', onAwareness);
    // Ask the server for this document's current cursors.
    this.syncDoc(fileId, replica);

    const synced = this.synced;
    return {
      awareness,
      readOnly: this.readOnly,
      get synced() {
        return synced.has(fileId);
      },
      saved: (text) => {
        this.projected.set(fileId, text);
        this.persistSoon(`doc:${fileId}`);
      },
      dispose: () => {
        open.off('update', toReplica);
        replica.off('update', toOpen);
        awareness.off('update', onAwareness);
        awarenessProtocol.removeAwarenessStates(awareness, [awareness.clientID], 'close');
        this.opts.client.send(
          MessageKind.Awareness,
          this.opts.vaultId,
          fileId,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
        );
        awareness.destroy();
        this.docAwareness.delete(fileId);
      },
    };
  }

  /** Text of a document as of a history snapshot (for restore). */
  async snapshotText(path: VaultPath, snapshotId: number): Promise<string | undefined> {
    const id = this.local.get(path);
    const codec = this.opts.documents.codecFor(path);
    if (!id || !codec) return undefined;
    const data = await this.opts.client.snapshot(this.opts.vaultId, id, snapshotId);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, data);
    const text = codec.serialize(doc, path);
    doc.destroy();
    return text;
  }
}
