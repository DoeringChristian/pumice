import type { VaultPath } from '@pumice/platform';
import type * as Y from 'yjs';
import type { Disposable, Event } from '../lifecycle';
import { defineService } from '../service';

/**
 * Maps between a file's bytes and the structure of its Y.Doc.
 * The markdown codec stores the whole file in `Y.Text('content')`.
 */
export interface DocumentCodec {
  id: string;
  /** Matched against the end of the file name, longest match wins. */
  extensions: string[];
  /** Fills an empty Y.Doc from file content. */
  load(doc: Y.Doc, content: string, path: VaultPath): void;
  serialize(doc: Y.Doc, path: VaultPath): string;
  /**
   * Applies an external file change. `base` is the content last read from or written to disk,
   * so the codec can do a three-way merge. Returns false on an unresolvable conflict
   * (the doc keeps its content and the caller saves `theirs` as a conflict copy).
   */
  mergeExternal(doc: Y.Doc, base: string, theirs: string, path: VaultPath): boolean;
}

/**
 * A persistence provider next to the file (docs/plan/05), e.g. collaboration. It can supply a
 * document's CRDT state instead of building it from the file, and keeps open docs in sync.
 */
export interface DocumentProvider {
  id: string;
  /** Whether this provider manages the file. */
  handles(path: VaultPath): boolean;
  /**
   * The document's state, and the file text that state was last written to disk as (the merge
   * base for changes made to the file meanwhile). Undefined: build the doc from the file.
   */
  load(path: VaultPath): Promise<{ state: Uint8Array; projected: string } | undefined>;
  /** Called once the doc is loaded; keep it in sync until disposed. */
  attach(doc: Y.Doc, path: () => VaultPath): DocumentAttachment;
}

export interface DocumentAttachment extends Disposable {
  /** y-protocols Awareness for presence (cursors) in this document. */
  readonly awareness?: unknown;
  /** True when the user may only read (e.g. viewer role in a shared vault). */
  readonly readOnly?: boolean;
  /** The file was written to disk with this text. */
  saved?(text: string): void;
}

export interface DocumentHandle extends Disposable {
  readonly doc: Y.Doc;
  /** Presence (y-protocols Awareness) when a provider offers it. */
  readonly awareness?: unknown;
  readonly readOnly: boolean;
  readonly codec: DocumentCodec;
  /** Current path; follows renames. */
  readonly path: VaultPath;
  readonly onDidRename: Event<VaultPath>;
  /** Fired after the file was deleted; the handle stays usable but will not be saved. */
  readonly onDidDelete: Event<void>;
  /** Serialized content. */
  text(): string;
  /** Writes pending changes now. */
  save(): Promise<void>;
  /** Releases this reference (same as dispose). The doc closes when the last reference goes. */
  dispose(): void;
}

/** Transaction origin for changes coming from the file on disk. */
export const ORIGIN_EXTERNAL_FILE = 'pumice:external-file';

export interface DocumentsApi {
  /** Opens (or shares an already open) document. Release with `handle.dispose()`. */
  open(path: VaultPath): Promise<DocumentHandle>;
  isOpen(path: VaultPath): boolean;
  /** Current content of an open document (including unsaved edits), undefined if not open. */
  peek(path: VaultPath): string | undefined;
  /** Content of the open document if open, else of the file on disk. */
  read(path: VaultPath): Promise<string>;
  /** Fires on every content change of an open document (local, remote or merged from disk). */
  readonly onDidChange: Event<VaultPath>;
  codecFor(path: VaultPath): DocumentCodec | undefined;
  registerCodec(codec: DocumentCodec): Disposable;
  registerProvider(provider: DocumentProvider): Disposable;
  /** Saves all open documents (on pause/quit). */
  flushAll(): Promise<void>;
}

export const Documents = defineService<DocumentsApi>('core.documents');

export function markdownText(doc: Y.Doc): Y.Text {
  return doc.getText('content');
}
