# Writing Pumice plugins

Everything in Pumice — the editor, the file explorer, search, backlinks, Excalidraw — is a
plugin built on the same API you use: `@pumice/api`. This guide gets you from zero to a working
plugin; the [API reference](../api/index.html) (generated with `pnpm docs:api`) lists every type.

## Quick start

```sh
npx pumice-plugin init my-plugin --id me.my-plugin --name "My plugin"
cd my-plugin
npm install
npm run dev -- /path/to/your/vault   # builds into the vault; Pumice reloads it on every save
```

Open the vault in Pumice, then **Settings → Community plugins** shows your plugin. Each rebuild
replaces the running plugin (its dependents are restarted too) without restarting the app.

To ship: `npm run build` writes `dist/manifest.json`, `dist/main.js` and `dist/styles.css`.
Users install them with **Install from files**, or **Install from URL** pointing at a folder
(for example a GitHub release) that contains those three files.

## Anatomy

```
my-plugin/
  manifest.json    id, name, version, api range, dependencies, permissions
  src/main.ts      export default definePlugin({ activate(ctx) { … } })
  styles.css       optional; loaded while the plugin is active
```

### manifest.json

```jsonc
{
  "id": "me.my-plugin", // lowercase, unique; "core." is reserved
  "name": "My plugin",
  "version": "1.0.0",
  "api": "^0.1.0", // @pumice/api versions you support
  "dependencies": { "core.workspace": "^0.1.0" }, // plugins whose services you use
  "optionalDependencies": { "core.settings": "^0.1.0" },
  "activation": ["onCommand:me.my-plugin.run"], // omit to activate at startup
  "contributes": { "commands": [{ "id": "me.my-plugin.run", "title": "Run my plugin" }] },
  "permissions": [], // "shell", "platform", "network", "clipboard"
}
```

Dependencies are activated first. If one is missing or fails, your plugin is not activated and
the reason shows in Settings. `contributes.commands` makes a command visible in the palette
before the plugin is loaded; running it activates the plugin (lazy activation).

### The plugin context

```ts
import { SettingsUi, Workspace, definePlugin } from '@pumice/api';

export default definePlugin({
  async activate(ctx) {
    const workspace = ctx.use(Workspace); // a service (throws if its plugin isn't active)
    const settingsUi = ctx.tryUse(SettingsUi); // optional service

    ctx.commands.register({
      id: 'me.hello',
      title: 'Hello',
      hotkeys: ['Mod+Shift+H'],
      run: () => workspace.notify('Hi'),
    });
    const item = ctx.register(workspace.addStatusBarItem()); // disposed on deactivate
    await ctx.settings.set('count', ctx.settings.get('count', 0) + 1); // .pumice/plugins/me.hello.json
    await ctx.storage.set('cache', '…'); // device-local, outside the vault
  },
});
```

Everything handed to `ctx.register`, and everything `register…` methods return through `ctx`,
is undone when the plugin is turned off or reloaded. Do the same for DOM listeners you add
(`ctx.register(() => el.removeEventListener(…))`).

## Services

| Service          | Plugin                      | Use it to                                                                          |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `Vault`          | core.vault                  | list, read, create, rename, delete files; watch changes                            |
| `Documents`      | core.documents              | edit notes as Yjs documents (merges with the editor, disk and collaborators)       |
| `MarkdownSyntax` | core.markdown               | parse markdown (mdast), extract metadata, add syntax extensions                    |
| `MetadataIndex`  | core.index                  | resolve links, backlinks, tags, headings, blocks, full-text search; add extractors |
| `Workspace`      | core.workspace              | views, tabs, sidebar panels, status bar, dialogs, notices, context menus           |
| `Editor`         | core.editor                 | CodeMirror extensions for every editor; the active editor                          |
| `Reader`         | core.reader                 | render markdown; embed, code-block and post-processor renderers                    |
| `Links`          | core.links                  | open links, note IDs (`[[id\|Name]]`), link suggestions                            |
| `Templates`      | core.templates              | render and apply templates                                                         |
| `SettingsUi`     | core.settings               | add a settings tab                                                                 |
| `ShellService`   | kernel (`shell` permission) | open URLs, reveal files                                                            |

### Editing notes

Never write a markdown file that may be open — go through `Documents`, which merges your change
with unsaved edits, collaborators and changes from disk:

```ts
const handle = await documents.open('Notes/Idea.md');
try {
  const text = markdownText(handle.doc); // Y.Text
  handle.doc.transact(() => text.insert(text.length, '\n- added by my plugin'));
} finally {
  handle.dispose(); // saved shortly after
}
```

For frontmatter, `setProperty(text, key, value)` returns a minimal text change that keeps the
YAML's comments and formatting.

### Links and IDs

Notes have a stable `id` in their frontmatter and links are written `[[id|Name]]`. To link to a
note from a plugin, use `links.linkTo(path)` (it assigns an ID if needed); to resolve a link as
Pumice does, `index.resolve(target, fromPath)`.

### Syntax extensions

A syntax extension is a pair: a Lezer config for the editor and a micromark + mdast extension
for the reading view, the index and export. See `examples/kbd-syntax` for a complete example
(`++Ctrl+C++` → keyboard keys) including a live-preview decoration.

## Shared libraries

`@pumice/api`, CodeMirror (`@codemirror/*`), Lezer (`@lezer/*`), Yjs and React are provided by
the app: `pumice-plugin build` does not bundle them, so your plugin uses the same instances as
the editor (required for CodeMirror extensions and Yjs documents to work). Everything else you
import is bundled into `main.js`.

## Trust

Plugins run in the app with full access to the page. Permissions in the manifest gate sensitive
services (`shell`, `platform`) to prevent accidents, not malice; users are told so before
installing. Sandboxed plugins are planned after v1.

## Examples

- `examples/word-goal` — services, status bar, a command, a settings tab.
- `examples/kbd-syntax` — a markdown syntax extension with both parsers and an editor decoration.
