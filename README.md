# Pumice

A local-first, extensible markdown note-taking app. Notes are plain files in a folder; the
editor, file explorer, search, backlinks, Excalidraw — everything — is a plugin built on the same
public API third-party plugins use. Reads and writes Obsidian vaults, links notes by stable ID
(`[[id|Name]]`) so renames never break links, and supports real-time collaboration through a
self-hostable server. See [docs/plan](docs/plan/README.md) for the architecture and roadmap.

## Install

macOS (Apple Silicon and Intel), with [Homebrew](https://brew.sh):

```sh
brew install --cask doeringchristian/pumice/pumice
```

The app is not signed with an Apple Developer certificate; the cask clears macOS's quarantine
flag so it opens normally. Android: download the APK from the
[latest release](https://github.com/DoeringChristian/pumice/releases/latest). Other platforms:
build from source (below).

On first start Pumice shows its vault selector: create a vault, or open any folder as one
(including an existing Obsidian vault). After that it reopens the last vault. Switch vaults with
the vault name at the top of the sidebar or **⌘/Ctrl+Shift+O**; "Manage vaults…" (also in the
File menu) brings the selector back.

## Getting started

Requires Node ≥ 22.5 (24 recommended) and pnpm 10 (`npx pnpm@10.18.0 …` works without installing).

```sh
git submodule update --init   # vendor/excalidraw: our Excalidraw fork with LaTeX
pnpm install
pnpm build:excalidraw         # builds the fork once (a few minutes; again after updating it)
pnpm test            # unit + integration tests (parsers, index, links, collaboration, plugins…)
pnpm typecheck
pnpm dev:web         # browser harness with an in-memory demo vault → http://localhost:5199
pnpm dev:desktop     # Electron app; asks for a vault folder (or set PUMICE_VAULT=/path)
```

In the browser harness, `window.pumice` exposes the kernel and the in-memory file system
(`pumice.platform.fs.external.write(path, text)` simulates an edit by another program;
`pumice.reset()` restores the sample vault).

### Collaboration server

```sh
cd apps/server
PUMICE_DEV_LOGIN=1 pnpm start    # http://localhost:8787, data in ./data (SQLite + blobs)
docker compose up                # or: the Docker image with a data volume
```

`PUMICE_DEV_LOGIN=1` shows login codes in the app instead of emailing them (wire SMTP into
`sendLoginCode` in `apps/server/src/server.ts` for production). In the app: **Settings →
Collaboration** → sign in → **Share this vault**, then create an invite link for others.

### Packaging

```sh
pnpm --filter @pumice/desktop package       # dmg/zip, nsis, AppImage/deb in apps/desktop/release
pnpm --filter @pumice/mobile ios|android    # needs Xcode / Android Studio; see apps/mobile/README.md
```

Signing and notarization read `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Packaged desktop builds update themselves
from GitHub releases (or `PUMICE_UPDATE_URL`).

### Plugins

```sh
npx pumice-plugin init my-plugin --id me.my-plugin
npx pumice-plugin dev my-plugin --vault /path/to/vault   # live reload into the running app
pnpm docs:api                                             # API reference → docs/api
```

Start with the [plugin guide](docs/plugins/README.md) and the plugins in `examples/`.

### Electron binary on Node ≥ 25

Electron's postinstall can stop half-way while unzipping on very new Node versions. If
`electron` reports "failed to install correctly", extract the cached zip by hand:

```sh
cd node_modules/.pnpm/electron@*/node_modules/electron
rm -rf dist && mkdir dist
ditto -x -k ~/Library/Caches/electron/*/electron-v*-darwin-*.zip dist   # macOS; use unzip elsewhere
printf 'Electron.app/Contents/MacOS/Electron' > path.txt                 # Linux: electron, Windows: electron.exe
```

## Layout

```
packages/
  api/                @pumice/api — the public plugin API (the only package plugins import)
  kernel/             plugin host: manifests, dependencies, lazy activation, enable/disable, hot reload
  markdown/           the dialect: micromark + Lezer extensions, metadata, rendering, frontmatter edits
  markdown-spec/      conformance corpus: both parsers must agree with recorded expectations
  platform/           Platform interfaces (fs, watcher, storage, lifecycle, shell, net)
  platform-memory/    in-memory platform (tests, browser harness)
  platform-electron/  renderer-side platform over the Electron preload bridge
  platform-capacitor/ iOS/Android platform over the native PumiceFs plugin
  collab-protocol/    versioned wire envelope shared by client and server
  plugin-cli/         pumice-plugin init/build/dev
  ui/                 theme, icons, fuzzy matching, DOM and settings helpers
  app/                boots the kernel with the bundled plugins; community plugin manager
plugins/              core plugins (each replaceable; vault, documents, markdown, workspace required)
  core-vault/ core-documents/ core-markdown/ core-index/ core-workspace/ core-editor/
  core-reader/ core-links/ core-explorer/ core-switcher/ core-palette/ core-search/
  core-backlinks/ core-outline/ core-tags/ core-properties/ core-graph/ core-excalidraw/
  core-templates/ core-daily/ core-collab/ core-settings/ core-theme/ core-diagnostics/
apps/
  web/                browser harness
  desktop/            Electron shell (+ electron-builder packaging, auto-update)
  mobile/             Capacitor shell + native PumiceFs plugin sources (Swift, Kotlin)
  server/             collaboration server: Yjs sync, accounts, vaults, blobs, history
examples/             example community plugins (word-goal, kbd-syntax)
```

## Since v1 (M7, docs/plan/09)

- **Ribbon**: plugins add buttons (`workspace.registerRibbonAction`): new note, daily note, quick
  switcher, command palette, graph, new drawing, templates, agent chat.
- **Tables**: in live preview a table is a grid — type in cells, Tab/Enter/arrows to move, handles
  for insert/move/delete/align/sort, `+` bars to add rows and columns. `Mod+Alt+T` inserts one.
- **Comments**: select text and click the comment button next to it (or `Mod+Alt+M`); the comment
  is written right there. Stored in `.pumice/comments/<note path>.json`, not in the markdown; they
  follow their text through edits. A comment or reply with `@agent` (or `@claude`, `@chatgpt`,
  `@codex`, `@gemini`) is answered by that agent in the thread, and it can edit the note.
- **Back and forward**: arrows in the tab bar, `Mod+Alt+←/→` and the mouse's back/forward buttons
  move through what a tab has shown.
- **Media**: images (including SVG), audio and video open in a tab, with zoom for images;
  double-click an embedded image to open it.
- **PDF annotator**: PDFs open in a tab. Select text to highlight it, add notes, list the
  highlights, and copy a quote with a link (`[[paper.pdf#page=3]]` opens that page). Annotations
  are kept in `.pumice/annotations/<pdf path>.json`, the PDF is never changed; highlights made
  with Obsidian's "PDF Annotator" plugin are taken over on first open.
- **Copy location**: `Mod+Alt+C` copies `path:line` for pasting into an agent; also "with text"
  and "link to block" in the right-click menu.
- **Assistant** (desktop): a chat in the right sidebar. Built in: **ChatGPT on your own plan**
  through OpenAI's "Sign in with ChatGPT" (nothing to install; it can search, read and, with your
  approval, edit notes). Also Claude Code, Codex and Gemini CLI through the Agent Client Protocol
  if you have them. `Mod+Alt+A` asks about the selection.
- **Slash commands** in the chat: type `/` for the agent's own commands (for example `/compact`);
  the built-in assistant has `/compact`, `/clear` and `/help`, and `/new` starts a new chat.
- **Files**: paste or drop images and files into a note; they go to the attachment folder set
  in Settings → Files (vault folder, a fixed folder, next to the note, or a subfolder), with a
  separate default folder for new drawings. Unset, both follow the vault's Obsidian settings.
- **LaTeX in drawings**: Excalidraw is built from our fork (`vendor/excalidraw`, upstream master +
  the MathJax subtypes PR #6037/#6936). Select a text, switch on "Math (LaTeX)" in its style panel and write `$…$`.

## Status

All milestones of the [roadmap](docs/plan/08-roadmap.md) are implemented; what was verified, and
how, is listed per milestone. Known gaps are at the end.

- **M0 Foundations, M1 Editing core** — kernel, platforms, vault, Yjs documents with three-way
  merge of external edits (fuzz-tested), workspace, editor with live preview, explorer,
  switcher, palette.
- **M2 Linking & knowledge** — full Obsidian dialect in both parsers (conformance corpus green),
  Obsidian-style `[[Name]]` links with a suggester and link updates on rename (note IDs and
  `[[id|Name]]` links are an optional plugin on top),
  metadata index in a worker (10k notes: 3.1 s cold, 77 ms warm; 50k: 17 s cold, 0.4 s warm),
  backlinks with unlinked mentions, outline, tags, properties, full-text search with filters,
  reading view, embeds (notes, sections, blocks, images, audio, video, PDF), callouts, KaTeX
  math, Mermaid. Decision D13: in-memory index instead of SQLite-WASM.
- **M3 Excalidraw** — `.excalidraw.md` (Obsidian) and `.excalidraw` files, element-level CRDT
  codec with byte-identical saves of untouched drawings, embeds as SVG, links and search,
  external-edit merging, export, offline fonts.
- **M4 Ecosystem** — community plugins (install from files/URL, enable/disable, hot reload),
  shared modules (one CodeMirror/React/Yjs), `pumice-plugin` CLI, guide and TypeDoc reference,
  examples, templates, daily notes, graph view (global and local), themes and CSS snippets,
  tabbed settings with plugin tabs.
- **M5 Collaboration** — server (Node, `node:sqlite`, WebSocket Yjs sync + awareness, roles,
  invites, blobs, snapshots/history, crash reports), shared vaults with full replicas projected
  to plain files, offline edits merged on reconnect, presence and remote cursors, viewer role
  read-only, version history restore. Decision D14: server-trusted first, E2EE later.
- **M6 Beta hardening** — 50k-note benchmark, Obsidian compatibility report, accessibility pass
  (tree keyboard navigation, ARIA states, reduced motion), electron-builder packaging and
  auto-update, opt-in crash reporting, CI packaging matrix.
- **Mobile** — Capacitor shell, `platform-capacitor`, native `PumiceFs` (Swift/Kotlin), phone
  layout with drawers and bottom bar, editor toolbar above the keyboard. The web part builds and
  the phone layout was checked in a 390 px viewport.

### Known gaps

- Mobile native projects have not been built or run: no Xcode / Android SDK was available. App
  Store / Play submission is therefore not done.
- Packaged desktop builds were produced and launched unsigned on macOS only.
- Login emails need an SMTP hook on the server; OIDC sign-in is not implemented.
- End-to-end encryption (D14) and partial replicas are post-beta.
- Not yet: hover previews, `.canvas` files, Excalidraw collaborator pointers, typing `[[` inside
  drawings, a configurable ID property name, syncing `.pumice/` configuration in shared vaults.
- The index snapshot for 50k notes is ~73 MB of JSON; fine on desktop, too large for the web
  harness's storage.
