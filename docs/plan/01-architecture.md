# 01 — Architecture

## Stack

| Concern       | Choice                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------- |
| Language      | TypeScript (strict)                                                                           |
| Monorepo      | npm workspaces (plain npm scripts; pnpm until 0.2.25)                                         |
| Bundling      | Vite (app), `electron-vite` (desktop), esbuild (plugins)                                      |
| Desktop shell | Electron, `contextIsolation: true`, no `nodeIntegration` in renderers                         |
| Mobile shell  | Capacitor (iOS, Android)                                                                      |
| Editor        | CodeMirror 6, `@lezer/markdown` with custom extensions                                        |
| Markdown AST  | micromark + mdast (unified ecosystem)                                                         |
| UI            | React for core UI; plugin API is DOM-based                                                    |
| CRDT          | Yjs, `y-codemirror.next`, `y-protocols` (awareness)                                           |
| Index         | SQLite compiled to WASM (`@sqlite.org/sqlite-wasm`) in a worker, OPFS-backed; FTS5 for search |
| Tests         | Vitest (unit), Playwright (desktop e2e), conformance fixtures (markdown)                      |
| Server        | Node, Yjs sync protocol (Hocuspocus or thin own layer), SQLite/Postgres, blob store           |

### Why SQLite-WASM everywhere

The index must run on desktop and mobile. A WASM build in a worker is the same code on Electron,
iOS and Android, keeps the main thread free, and the index stays a rebuildable cache. If
benchmarks (see [roadmap](08-roadmap.md) spike S4) show it is too slow on mobile, swap in a native
SQLite behind the same `IndexStore` interface.

## Process model

```
Desktop (Electron)
┌──────────────────────────────────────────────────────────────┐
│ main process                                                 │
│  windows, menus, file watching (@parcel/watcher),            │
│  fs access, protocol handler pumice://, auto-update          │
└──────────────▲───────────────────────────────────────────────┘
               │ narrow IPC (preload exposes Platform impl)
┌──────────────┴───────────────────────────────────────────────┐
│ renderer (one per window)                                    │
│  kernel → plugin host → core + community plugins             │
│  Yjs docs, CodeMirror, React UI                              │
│   ├── worker: indexer (parse md → SQLite)                    │
│   ├── worker: search / heavy parsing                         │
│   └── (later) sandboxed plugin workers / iframes             │
└──────────────────────────────────────────────────────────────┘

Mobile (Capacitor): same renderer bundle; Platform impl backed by
Capacitor plugins (Filesystem, App lifecycle, Share, Haptics) plus
a small custom native plugin for bulk stat/read (see 07-mobile).
```

The renderer bundle is identical across shells. Only the `Platform` implementation differs.

## Platform abstraction

`packages/platform` defines interfaces; each shell provides an implementation. Plugins only see
higher-level services (Vault, Documents) built on top — never `Platform` directly, except through
explicitly permissioned APIs.

```ts
interface Platform {
  readonly kind: 'desktop' | 'mobile' | 'web';
  readonly os: 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown';
  fs: PlatformFs; // vault-scoped: list, stat, read, write, rename, remove, mkdir
  watch?: PlatformWatcher; // desktop only; mobile rescans on resume
  storage: AppStorage; // per-device app data dir (index cache, CRDT state, settings)
  lifecycle: Lifecycle; // resume/pause/quit events
  shell: Shell; // open external URL, reveal in file manager, share sheet
  clipboard: Clipboard;
  net: Net; // fetch/websocket with permission checks
}

interface PlatformFs {
  list(dir: VaultPath, opts?: { recursive?: boolean }): Promise<FileStat[]>;
  stat(path: VaultPath): Promise<FileStat | null>;
  readText(path: VaultPath, opts?: { maxBytes?: number }): Promise<string>;
  readBinary(path: VaultPath): Promise<Uint8Array>;
  writeAtomic(path: VaultPath, data: string | Uint8Array): Promise<void>; // temp file + rename
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  remove(path: VaultPath, opts?: { trash?: boolean }): Promise<void>;
  mkdir(path: VaultPath): Promise<void>;
}
```

A `platform-memory` implementation (in-memory fs) is used for unit tests and a browser demo.

## Repository layout

```
apps/
  desktop/              Electron main + preload, packaging (electron-builder)
  mobile/               Capacitor project (ios/, android/), native helper plugin
  server/               collaboration server (Docker image, self-hostable)
packages/
  api/                  @pumice/api — public plugin API types (the only thing plugins import)
  kernel/               plugin host, service registry, events, commands, settings, disposables
  platform/             Platform interfaces
  platform-electron/    renderer-side impl over preload IPC
  platform-capacitor/   impl over Capacitor plugins
  platform-memory/      in-memory impl for tests/demo
  ui/                   shared React components, theme tokens (CSS variables)
  markdown-spec/        dialect conformance fixtures + runners
  plugin-cli/           scaffold/build/dev-reload for plugin authors
plugins/
  core-vault/  core-documents/  core-index/  core-markdown/  core-editor/
  core-reader/ core-workspace/  core-explorer/ core-search/  core-backlinks/
  core-outline/ core-properties/ core-tags/  core-graph/   core-switcher/
  core-palette/ core-templates/ core-daily/  core-settings/ core-theme/
  core-collab/  core-excalidraw/
docs/
  plan/                 this plan
```

## Cross-cutting principles

1. **Files are the source of truth** (local vaults). Nothing in the vault except the user's files and
   a small `.pumice/` config folder (settings, enabled plugins, themes) — no index files.
2. **Everything derived is disposable** — index, rendered previews, thumbnails live in app storage
   and can be deleted.
3. **Main thread is for interaction** — parsing, indexing, search, export run in workers.
4. **Lazy everything** — plugins activate on events (file type opened, command run); Excalidraw's
   bundle loads only when a drawing is opened or embedded.
5. **Same bundle on every platform** — platform differences are data (`platform.kind`) and
   `Platform` implementations, not forks.
6. **Theming via CSS variables** — plugins and themes override tokens, not internal class names
   (internal class names are not API).

## Security baseline

- Electron: context isolation, sandboxed renderers, strict CSP, no remote content in privileged
  contexts, preload exposes a minimal typed API, IPC validates every argument and scopes fs to the
  vault root.
- Plugins in v1 run in the renderer realm (see [02](02-plugin-system.md#trust-and-sandboxing));
  permissions are declared and enforced at the API level but this is not a security boundary.
- Server: TLS only, per-vault access control, encryption at rest (E2EE is an open question, see
  [05](05-collaboration.md#end-to-end-encryption)).
