# 04 — Vault, identity & index

> **Revised by D18:** the core now links by name, as Obsidian does. Everything below about note
> IDs (assignment, `[[id|Name]]` links, duplicate handling, moves detected by ID) describes the
> optional `core.ids` plugin, which is off for writing links by default. Title history and
> stale-alias display were dropped.

## Vault

A vault is a folder. Contents:

- the user's files (markdown, drawings, attachments, anything else);
- `.pumice/` — vault-level configuration only: enabled plugins, plugin settings scoped to the
  vault, themes, CSS snippets, workspace layout. Small, human-readable, safe to sync or ignore.

No index, cache or CRDT state is stored in the vault. Those live in per-device app storage, keyed
by a vault UUID stored in `.pumice/vault.json`.

## Note identity

- Identity is the frontmatter `id` property (key name configurable; an existing `id` written by
  other tools is respected as long as it is unique).
- Files without an `id` have a **path identity** until they need a real one.
- An ID is written into a file only when:
  1. Pumice creates the note, or
  2. something links to the note through the suggester (the target gets an ID at that moment), or
  3. the user runs "Assign IDs to all notes", or
  4. the vault is shared (see [05](05-collaboration.md#vault-manifest)).

  This avoids rewriting thousands of files the first time a vault is opened.

- Editing the `id` line by hand is treated as an identity change: the editor protects the line
  (read-only decoration, "change ID" command with a warning that inbound ID links will fall back
  to name resolution).

### ID format

- 10 characters, Crockford base32, lowercase (alphabet `0123456789abcdefghjkmnpqrstvwxyz`),
  random: 50 bits. Collision probability for 100k notes ≈ 4·10⁻⁶; collisions are detected anyway.
- Short enough to keep raw markdown readable; no ordering semantics (creation time comes from
  file metadata or a `created` property).
- Pattern: `^[0-9a-hjkmnp-tv-z]{10}$`.

### Duplicate IDs

Caused by copying files, templates containing an ID, or sync conflicts.

- The index detects duplicates on scan.
- Rule: the file that has held the ID longest (by the index's first-seen record, falling back to
  earliest creation time) keeps it; the other gets a new ID **after** user confirmation in a
  non-blocking notice ("2 notes share an ID — fix").
- Templates: the template plugin strips `id` from template output and assigns a fresh one.

### Attachments

Binary files cannot carry frontmatter.

- Local vaults: attachments have path identity. Moves are detected by matching size + content
  hash of a disappeared path against a new path within the same scan.
- Shared vaults: every file, including attachments, has an ID in the vault manifest (CRDT), so
  attachments get stable identity without sidecar files.

## Link resolution

Input: link target string `T` (before `#` and `|`), source note `S`.

1. **ID**: if `T` matches the ID pattern and exists in the index → that note.
2. **Path**: if `T` contains `/` or an extension, resolve as a vault path (relative to vault root,
   then relative to `S`'s folder).
3. **Name**: exact basename match (case-insensitive, NFC-normalized); on ties prefer the shortest
   path, then the note closest to `S` in the folder tree (Obsidian's behaviour).
4. **Alias**: match against `aliases` properties.
5. Otherwise **unresolved**: rendered as a ghost link; clicking creates the note (with an ID) in the
   configured folder and upgrades the link to `[[id|Name]]`.

Subpath: `#Heading` resolved against the target's headings (slug-insensitive match), else (and `#^name`)
against the names of places. When linking to a heading, the suggester offers "link to a stable block ID
instead", because heading renames still break heading links.

## Renames and moves

| Event                                        | Behaviour                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rename/move inside Pumice                    | ID links: nothing to do. Plain `[[Name]]` / path links: rewritten (setting, default on), as Obsidian does. Stale display texts handled per [03](03-markdown-dialect.md#id-links). |
| Move outside Pumice (Finder, `git mv`, sync) | Watcher/rescan sees path A gone and path B appear with the same ID → recorded as a move; links keep working; plain links are offered for rewrite.                                 |
| Delete                                       | Inbound links become unresolved; backlinks pane lists them.                                                                                                                       |
| ID changed by hand                           | Treated as a new note; inbound ID links fall back to name resolution.                                                                                                             |

The index keeps a per-note **title history** (former basenames and titles) so stale display texts
can be recognised. It is a cache: if lost, stale texts are shown as written.

## Index

> **Revised in M2 (decision D13):** the index is kept in memory (lookup maps + MiniSearch for
> full-text), markdown is parsed in a worker, and a JSON snapshot in app storage gives the warm
> start. The schema below still describes what is indexed. Measured: 10k notes cold 3.1 s,
> warm 77 ms.

Originally planned: lives in a worker; SQLite (WASM, OPFS) in app storage. Fully rebuildable from the vault.

### Schema (sketch)

```sql
files       (fid INTEGER PK, path TEXT UNIQUE, id TEXT, kind TEXT, size INT, mtime INT,
             hash TEXT, first_seen INT, title TEXT)
ids         (id TEXT, fid INT)                       -- allows detecting duplicates
title_hist  (fid INT, title TEXT, until INT)
links       (src INT, kind TEXT /* link|embed|mdlink */, raw TEXT, target_id TEXT,
             target_path TEXT, subpath TEXT, display TEXT, start INT, end INT)
headings    (fid INT, level INT, text TEXT, slug TEXT, start INT)
blocks      (fid INT, block_id TEXT, start INT, end INT)
tags        (fid INT, tag TEXT, start INT)
properties  (fid INT, key TEXT, value_json TEXT)
fts         VIRTUAL TABLE USING fts5(path, title, body, content='')
meta        (key TEXT PK, value TEXT)                -- schema version, parser version
```

Resolved targets are computed in a separate pass so that renames only re-resolve affected links.

### Lifecycle

1. **Open vault**: load index; walk the vault with `stat` only; compare `(size, mtime)` per path.
2. Changed/new files: read and parse in the worker (frontmatter first, so IDs are known early),
   then full parse.
3. Missing files: check for moves (same ID or same hash elsewhere) before deleting rows.
4. **Live**: watcher events (desktop) or rescans on resume (mobile) feed the same pipeline.
   Edits from open documents are indexed from the in-memory Yjs doc, debounced.
5. **Rebuild**: schema or parser version change, corruption, or the user's "Rebuild index".

Targets: open a 10k-note vault with a warm cache in < 1 s to interactive; cold full index of 10k
notes in < 15 s on a mid-range laptop, with the UI usable during indexing (IDs and titles first).

### Public API (via `MetadataIndex` service)

`getFile(idOrPath)`, `resolveLink(target, from)`, `backlinks(id)`, `outgoing(id)`,
`headings(id)`, `blocks(id)`, `tags()`, `query(sql-like filter DSL)`, `search(text, opts)`,
change events (`onChanged(fileIds)`), and `registerExtractor` for plugin metadata.
