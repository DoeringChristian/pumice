# 05 — Collaboration

Real-time collaborative editing of notes and drawings, offline-first, while keeping the vault a
folder of plain files on every device.

## Core idea: one document model, several persistence providers

Every open document is a **Yjs `Y.Doc`** in memory, whether or not the vault is shared:

```
              ┌───────────── Y.Doc (per note / drawing) ─────────────┐
 editor ⇄ y-codemirror │  Y.Text "content" (whole file incl. frontmatter) │
 plugins ⇄ Documents   └───────────────┬──────────────┬────────────────┘
                                       │              │
                            FileProvider          CollabProvider (shared vaults only)
                         (vault file on disk)   (local Y state + server sync)
```

- **Local vault**: only `FileProvider`. The file is the source of truth; the Y.Doc is created from
  it on open and discarded on close. No CRDT state is stored.
- **Shared vault**: `CollabProvider` is added. The CRDT is the source of truth for content; the
  file on disk is a continuously written **projection** so the folder remains plain markdown that
  other tools, git and backups can read.

This gives plugins a single API (`Documents`) and makes "share this vault" a matter of attaching a
provider, not switching editing engines.

## FileProvider: reconciling files and the in-memory doc

State per document: `projected = { text, hash }` — the content last read from or written to disk.

**Writing** (doc → file): debounced (~1 s after the last change, immediately on blur, close, quit
and app pause on mobile); atomic write (temp file + rename); update `projected`.

**External change** (file → doc), detected by the watcher or a rescan:

1. Read disk text `D`. If `hash(D) == projected.hash` → our own write, ignore.
2. Otherwise three-way merge: `base = projected.text`, `ours = Y.Text`, `theirs = D`.
3. Non-overlapping changes merge cleanly. The result is applied to the Y.Text as a minimal diff
   (transaction origin `external-file`, so it's excluded from the local undo stack but synced to
   collaborators).
4. Overlapping changes (rare: same region edited in Pumice and externally within one debounce
   window): keep ours, save theirs as a conflict copy, and show a notice with a diff/resolve view.
5. Set `projected = merged result` and write it back if it differs from `D`.

The same mechanism handles edits from other editors, git checkouts and file-sync tools.

## Shared vaults

### Vault manifest

A vault-level `Y.Doc` describing the file tree:

```
Y.Map "files": fileId → Y.Map {
  path: string,            // vault-relative
  kind: 'note' | 'drawing' | 'attachment' | 'other',
  blob?: sha256,           // binaries: content-addressed blob
  deleted?: timestamp,     // tombstone; content kept for restore
  created, createdBy
}
Y.Map "folders": path → { created }   // only needed for empty folders
```

- Every file in a shared vault has a `fileId`; for notes and drawings it equals the frontmatter
  `id` (assigned to all notes when a vault is first shared). Attachments get IDs here — no sidecar
  files needed.
- **Renames/moves** are a `path` update — last writer wins, which is fine for a path.
- **Path collisions** (two files concurrently given the same path): resolved deterministically on
  every client (the entry with the higher `(clock, clientID)` gets a ` (2)` suffix), so all devices
  converge to the same tree without coordination.
- **Delete vs. concurrent edit**: delete wins, the content stays restorable from trash (30 days),
  and the editor of the deleted note is notified.

### Content documents

- **Notes**: one `Y.Doc` per note, `Y.Text "content"` holding the whole file. Frontmatter is
  plain text inside it; the `id` line is protected in the editor.
- **Drawings**: see [06](06-excalidraw.md#collaboration).
- **Attachments**: not CRDTs. Uploaded to the server blob store by hash; the manifest references the
  hash. A concurrent replace of the same attachment is last-writer-wins, with the previous blob kept
  in history.

### Replication

- v1: **full replica** on every device — all docs and blobs synced and projected to disk. This keeps
  the index, search and backlinks purely local and working offline.
- Local Yjs state is persisted in app storage (not in the vault) so devices start offline and
  sync only deltas (Yjs state vectors).
- Later: partial replicas (lazy docs/blobs) for very large vaults on mobile.

### Joining and creating

- **Share an existing vault**: assign IDs to all notes, build the manifest, upload docs and blobs.
- **Join**: choose an empty folder; manifest syncs, docs and blobs stream in, files are projected.
- Merging two pre-existing vaults into one shared vault is out of scope for v1.

### Vault configuration

`.pumice/` vault config syncs as ordinary files (JSON, last-writer-wins per file). Per-device
settings (window layout, hotkeys if marked per-device) don't sync.

## Presence (awareness)

Via `y-protocols/awareness`:

- user name, color, avatar; current file; cursor/selection in the editor (y-codemirror remote
  cursors); pointer and selection in Excalidraw;
- indicators: avatars on tabs and file-explorer entries, "follow user" mode;
- a `Presence` contribution point so plugin views can show presence too.

## Undo/redo

`Y.UndoManager` scoped to local origins only: undo never reverts a collaborator's edits.
External-file merges are not undoable from the editor (they're recoverable from history).

## History

The server keeps periodic Y snapshots per document (e.g. every 10 min of activity and on session
end), giving version history and restore for every note and drawing. Local vaults rely on the
file system (git, Time Machine); a local "file recovery" plugin with periodic snapshots in app
storage can come later.

## Server (`apps/server`)

| Concern        | Choice                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | Node, TypeScript, shares types with the client                                                                                                 |
| Sync           | Yjs sync + awareness protocol over WebSocket (Hocuspocus, or a thin own layer over `y-protocols`)                                              |
| Storage        | Postgres (multi-user) or SQLite (single-node self-host); doc updates appended, compacted periodically                                          |
| Blobs          | filesystem or S3-compatible; content-addressed, deduplicated                                                                                   |
| Auth           | accounts via email magic link and OIDC; short-lived access tokens; device sessions                                                             |
| Access control | per-vault membership: owner / editor / viewer; enforced server-side (viewers' updates rejected) and reflected in the client (read-only editor) |
| Deployment     | single Docker image, `docker compose` with Postgres; horizontal scaling via Redis pub/sub later                                                |

The sync protocol is wrapped in a small versioned envelope (`{ v, vault, doc, payload }`) so that
encryption (below) or protocol changes can be introduced without breaking clients.

## End-to-end encryption

**Decided in M5 (D14):** server-trusted for the first beta; the envelope is versioned so E2EE can follow as protocol version 2.

Originally an open decision; it had to be made before the server protocol is frozen (milestone M5).

- **Server-trusted** (simplest): TLS + encryption at rest. Server can compact, snapshot and
  (later) offer server-side features like web access.
- **E2EE**: each Yjs update and blob encrypted with a per-vault key, wrapped for each member's
  device key. The server stores and relays opaque bytes; clients do compaction and upload
  encrypted snapshots. Costs: key management, device enrolment, account recovery, no server-side
  features.

Recommendation: design for E2EE from the start (envelope, client-side compaction), ship
server-trusted in the first collaboration beta only if E2EE delays it significantly.

## Interaction with other sync tools

- Local vaults: any file sync (git, Syncthing, iCloud, Dropbox) works; FileProvider merges
  external changes.
- Shared vaults: git on top is fine (it just reads projected files). Syncing the _same_ shared vault
  folder between devices with another file-sync tool is unsupported (it usually converges, but
  wastes work and can produce conflict copies); Pumice warns when it detects it.
