# 02 — Plugin system

Goal: the kernel knows almost nothing about notes. The editor, workspace, vault, file explorer,
search, Excalidraw — all are plugins using the same public API (`@pumice/api`) that community
plugins use. If a core feature needs something the API cannot do, the API is extended; core
plugins get no private back doors.

## Kernel responsibilities (the only non-plugin code)

- **Plugin host**: discover, validate manifests, resolve dependency graph, activate/deactivate.
- **Service registry**: typed tokens; plugins provide and consume services.
- **Event bus**: typed events, scoped subscriptions.
- **Command registry** and **keymap** resolution.
- **Settings store**: per-plugin, per-vault and per-device scopes, with JSON schema.
- **Disposables**: everything registered through a plugin context is torn down on unload.
- **Logging / diagnostics**: per-plugin logs, activation timing, error isolation.
- Boot sequence: load `Platform` → kernel → resolve enabled plugins → activate `onStartup` set →
  hand the root DOM element to whichever plugin provides the `Workspace` service.

The kernel renders no UI itself (apart from a fatal-error screen).

## Manifest

```jsonc
// plugins/core-excalidraw/manifest.json
{
  "id": "core.excalidraw",
  "name": "Excalidraw",
  "version": "0.1.0",
  "api": "^1.0.0", // @pumice/api range
  "main": "main.js",
  "styles": "styles.css",
  "platforms": ["desktop", "mobile"],
  "dependencies": {
    // plugin id → semver range
    "core.workspace": "^1.0.0",
    "core.documents": "^1.0.0",
    "core.markdown": "^1.0.0",
  },
  "optionalDependencies": { "core.collab": "^1.0.0" },
  "provides": ["excalidraw.scenes"], // service ids it registers
  "activation": [
    // lazy activation events
    "onFileType:excalidraw",
    "onEmbed:excalidraw",
    "onCommand:excalidraw.new",
  ],
  "contributes": {
    // static, readable without activating the plugin
    "commands": [{ "id": "excalidraw.new", "title": "New drawing" }],
    "fileTypes": [{ "id": "excalidraw", "match": ["*.excalidraw.md", "*.excalidraw"] }],
    "settings": "settings.schema.json",
  },
  "permissions": [], // e.g. "network", "clipboard", "fs:outside-vault"
}
```

Static `contributes` lets the app show commands, file types and settings before activation
(VS Code's model), which keeps startup fast.

## Plugin entry point

```ts
import { definePlugin, Documents, Workspace } from '@pumice/api';

export default definePlugin({
  async activate(ctx) {
    const workspace = ctx.use(Workspace);
    const docs = ctx.use(Documents);

    ctx.register(workspace.registerView('excalidraw', (leaf) => new ExcalidrawView(leaf, docs)));
    ctx.register(ctx.commands.register('excalidraw.new', () => createDrawing(docs)));

    ctx.provide(ExcalidrawScenes, new SceneService(docs));
  },
  // optional; everything passed to ctx.register is disposed automatically
  async deactivate() {},
});
```

`ctx` provides: `use`, `provide`, `register`, `commands`, `events`, `settings`, `storage`
(plugin-private app storage), `log`, `manifest`, `platform` (kind/os only; capabilities via
permissioned services).

## Services

```ts
export const Vault = defineService<VaultApi>('core.vault', '1.0.0');
```

- Tokens are typed and versioned; `ctx.use` checks the provider's version against the consumer's
  declared dependency range.
- **Replaceable**: a service has exactly one active provider. Another plugin can declare
  `"replaces": "core.search"` and provide the same service tokens — e.g. a different search engine
  or a different editor. The user picks in settings.
- Services may be **multi-provider registries** (contribution points below) where many plugins add
  entries.

## Contribution points

| Contribution point                                     | Provided by    | Examples                                                            |
| ------------------------------------------------------ | -------------- | ------------------------------------------------------------------- |
| Commands, keybindings                                  | kernel         | palette entries, hotkeys                                            |
| Views (pane types)                                     | core.workspace | editor, graph, backlinks, Excalidraw                                |
| Ribbon, status bar, menus (file, editor, link context) | core.workspace |                                                                     |
| File-type handlers                                     | core.workspace | `.md` → editor, `.excalidraw.md` → Excalidraw, `.pdf` → viewer      |
| Markdown syntax extensions                             | core.markdown  | callouts, math, custom syntaxes (pair: Lezer + micromark)           |
| Editor extensions                                      | core.editor    | CM6 extensions: decorations, widgets, keymaps, autocomplete sources |
| Render post-processors / code-block renderers          | core.reader    | `mermaid`, `math`, query blocks                                     |
| Embed renderers                                        | core.reader    | `![[drawing]]`, `![[note#heading]]`, images, PDFs                   |
| Link suggesters                                        | core.editor    | `[[` autocomplete sources (notes, headings, blocks, drawings)       |
| Indexer extensions                                     | core.index     | extract custom metadata into the cache                              |
| Search providers                                       | core.search    |                                                                     |
| Settings tabs                                          | core.settings  |                                                                     |
| Themes / CSS snippets                                  | core.theme     |                                                                     |
| Document persistence providers                         | core.documents | file provider, collab provider                                      |
| Document codecs (file type ↔ Y.Doc)                    | core.documents | markdown (Y.Text), Excalidraw (element map)                         |
| Presence renderers                                     | core.collab    | cursors in editor, pointers in Excalidraw                           |

## Lifecycle and activation

- States: `discovered → resolved → activating → active → deactivating → inactive | failed`.
- Activation order follows the dependency graph; cycles are a validation error.
- A plugin that throws during activation is marked `failed`; dependents are not activated; the app
  keeps running.
- **Hot reload** in dev mode (`plugin-cli dev`): deactivate → reload bundle → activate.
- Long `activate` calls are measured and shown in a startup profiler.

## Documents, not files

Plugins that change note content go through `Documents` transactions, never raw file writes:

```ts
const doc = await docs.open(noteId); // Yjs-backed, shared with any open editor
doc.transact((tx) => tx.insert(pos, 'text')); // merges with concurrent local/remote edits
```

`Vault.write` on a markdown file that is open or shared is routed to `Documents` automatically,
so naive plugins don't clobber concurrent edits. See [05](05-collaboration.md).

## Trust and sandboxing

- **v1**: all plugins run in the renderer realm. Permissions in the manifest gate access to
  sensitive services (`network`, `clipboard`, `fs:outside-vault`, `shell`). The install UI shows
  them. This prevents accidents, not malice; this is stated clearly to users.
- **API designed for later isolation**: data-oriented services (vault, index queries, documents,
  settings) are **async and serializable**, so they can be proxied over `postMessage` to a worker or
  iframe later. UI-heavy contributions (CM6 extensions, views) remain same-realm.
- **Later**: "logic-only" community plugins run in workers; view plugins in sandboxed iframes with
  an RPC bridge.

## Distribution

- v1: plugins installed from a folder or URL (zip with manifest); core plugins bundled.
- Later: a registry (index of GitHub releases, like Obsidian's community list), signature checks,
  auto-update.
- Mobile: same JS bundles loaded into the webview (see [07](07-mobile.md) for App Store notes).

## API stability

- `@pumice/api` is the only package plugins import; semver; deprecations live for a full major.
- Internal class names, DOM structure and non-exported modules are not API.
- API docs generated from types (TypeDoc) + guide + example plugins.

## Obsidian compatibility shim (post-v1)

A separate plugin (`compat.obsidian`) that implements a subset of Obsidian's `App`, `Plugin`,
`Vault`, `MetadataCache`, `Workspace`, `MarkdownView` on top of our services, so popular
community plugins can run unmodified. Node-dependent plugins stay desktop-only or unsupported.

## Core plugins

| Plugin                                                               | Provides                           | Notes                                                                 |
| -------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| core.vault                                                           | `Vault`                            | file tree, fs ops, ID assignment, move detection                      |
| core.documents                                                       | `Documents`                        | Yjs doc lifecycle, persistence providers, transactions                |
| core.markdown                                                        | `MarkdownSyntax`, `MarkdownParser` | dialect, syntax extension registry                                    |
| core.index                                                           | `MetadataIndex`                    | worker + SQLite: links, backlinks, tags, headings, blocks, properties |
| core.workspace                                                       | `Workspace`                        | panes, tabs, splits, layout persistence, file-type routing            |
| core.editor                                                          | `Editor`                           | CM6, live preview, link autocomplete                                  |
| core.reader                                                          | `Reader`                           | reading view, embeds, post-processors                                 |
| core.explorer                                                        | —                                  | file tree view                                                        |
| core.switcher / core.palette                                         | —                                  | quick switcher, command palette                                       |
| core.search                                                          | `Search`                           | FTS + query syntax                                                    |
| core.backlinks, core.outline, core.tags, core.properties, core.graph | —                                  | side views                                                            |
| core.templates, core.daily                                           | —                                  |                                                                       |
| core.settings, core.theme                                            | `SettingsUi`, `Theme`              |                                                                       |
| core.collab                                                          | `Collab`                           | shared vaults, presence (see [05](05-collaboration.md))               |
| core.excalidraw                                                      | `ExcalidrawScenes`                 | see [06](06-excalidraw.md)                                            |

Required for a functioning app: vault, documents, markdown, workspace (each replaceable, not
removable). Everything else can be disabled.
