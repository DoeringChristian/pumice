# 09 — Authoring tools and agents (M7)

Features added after v1 scope: a ribbon of quick actions, a table editor, comments, copyable text
locations, AI coding agents working inside the vault, and an Excalidraw fork with LaTeX.
Everything is a plugin; the new extension points go into `@pumice/api`.

## Ribbon

A vertical strip of icon buttons at the far left of the window (desktop/tablet); on phones the same
actions appear at the top of the left drawer.

```ts
workspace.registerRibbonAction({ id, icon, title, order?, run(): void }): Disposable;
```

Core plugins register: daily note (`core-daily`), quick switcher, command palette, graph, new
drawing (`core-excalidraw`), templates, agent chat (`core-agents`). Users can hide individual
actions (`.pumice/workspace.json` → `ribbon.hidden`); right-click on the ribbon lists them.

## Tables (`core-tables`)

In live preview a GFM table is an interactive grid instead of a static render (source mode keeps
the raw pipes). Interaction model borrowed from document editors:

- Click a cell to edit it in place (a small inline CodeMirror-free `contenteditable`, plain text
  plus inline markdown kept verbatim). `Tab`/`Shift+Tab` move between cells (Tab in the last cell
  adds a row), `Enter` moves down, `Esc` or clicking outside leaves the table.
- Hovering a row or column shows a handle; the handle menu offers insert above/below/left/right,
  delete, move, alignment (left/center/right) for columns, and sort by column.
- `+` buttons at the right edge and bottom add a column/row.
- A "Source" toggle (or `Mod+/` inside the table) shows the raw markdown for that table.
- Every edit rewrites the table's markdown as one transaction (undoable, collaborative), formatted
  with padded columns; escaped pipes (`\|`) and wikilinks inside cells survive.
- Commands: insert table (rows × columns picker), format table, convert selection (CSV/TSV paste)
  to table.

The grid model (`parseTable`/`formatTable`/operations) lives in `@pumice/markdown` with unit tests;
the widget is a CodeMirror block widget owned by `core-tables` (replacing the static table widget
of `core-editor` through a `previewBlockRenderer` extension point).

## Comments (`core-comments`)

Comments annotate a range of text; they are **not** written into the note (notes stay clean
markdown, readable by Obsidian and agents without noise).

- **Storage**: sidecar `.pumice/comments/<note path>.json`; the sidecar is moved along when
  the note is renamed or moved in the app. Each thread: `{ id, anchor, resolved, comments: [{ id, author, body,
created, edited? }] }`.
- **Anchoring**: W3C Web Annotation style — `{ exact, prefix, suffix, start }` (quote plus 32 chars
  of context plus the last known offset). While a note is open, anchors are tracked through edits
  by CodeMirror position mapping and re-saved; when the file changed elsewhere they are re-found by
  quote/context (fuzzy, nearest to `start`). Anchors that can't be found become "detached" and are
  listed at the end of the panel.
- **Collaboration**: in shared vaults the sidecar is synced like a note (a Y.Doc per sidecar,
  threads as a Y.Map, anchors as Yjs relative positions while open), so comments are live.
- **UI**: highlighted ranges in the editor and reading view; a gutter marker; a "Comments" sidebar
  panel with threads in document order, reply, edit, resolve, delete; `Mod+Alt+M` comments the
  selection. Authors come from the collab identity, or a local name setting.
- **API**: `Comments` service (`threads(path)`, `add`, `reply`, `resolve`, `onDidChange`) so agents
  and other plugins can read and write comments.

## Copy location (`core-links`)

For pasting a precise reference into an agent or a chat:

- **Copy location** (`Mod+Alt+C`, context menu): `Notes/Meeting.md:12-14` (vault-relative path,
  1-based lines; `:12:5-12:20` with columns for a sub-line selection).
- **Copy location with text**: the location plus the selected text in a fenced block.
- **Copy link to selection**: an Obsidian-compatible `[[id#^block|Title]]`, adding a `^block-id` if
  needed (or a heading link when the selection is a heading).
- Setting: absolute vs vault-relative paths, and the format (`path:line`, `@path#L12-14`).

## Agents (`core-agents`)

Run coding agents (Claude Code, Codex, Gemini CLI, …) against the vault from inside the app, using
the user's own installed CLI and **subscription** login, no API keys required.

- **Protocol**: the [Agent Client Protocol](https://agentclientprotocol.com) (ACP, JSON-RPC over
  stdio), as used by Zed. Agents: Claude Code via the `claude-code-acp` adapter (Claude Agent SDK;
  uses the Claude subscription login), Codex via `codex-acp` (ChatGPT subscription login), Gemini
  CLI natively (`gemini --experimental-acp`), plus any custom command. Each agent is a configured
  command; the plugin checks it is installed and shows the login hint if not.
- **Process**: desktop only (the Electron main process spawns the agent with the vault folder as
  working directory; the `Platform` gets a `process.spawn` capability). Mobile and web show the
  panel disabled; a server-side runner is a later option.
- **Client side of ACP**: Pumice answers `fs/read_text_file` and `fs/write_text_file` through the
  `Documents` service, so an agent's edits to open notes merge live into the editor (and into
  collaboration) instead of racing the file on disk; `session/request_permission` shows an
  approve/deny prompt; terminal requests are shown read-only in the chat.
- **Chat panel**: a right-sidebar view with sessions per agent, streaming messages, tool calls
  (with diffs of edited notes, click to open), plan/todo updates, stop, and new session.
- **Context**: "Ask agent about selection" (command, context menu) sends the current note path,
  selection location (see Copy location) and text as ACP resource links; `@` in the prompt box
  completes notes. Comment threads can be handed to an agent ("Ask agent to address").
- **Safety**: agents run with the user's permissions in the vault folder; the permission prompts
  are the agent's own; the panel shows which agent and mode are active.

## Excalidraw with LaTeX

`core-excalidraw` builds against a Pumice fork of Excalidraw: upstream master plus the MathJax
subtypes work from excalidraw/excalidraw#6037 / #6936 (by Daniel J. Geiger), rebased, as a git
submodule at `vendor/excalidraw`. A build step produces the library package that the plugin
depends on; MathJax is bundled (no CDN; the app runs offline under a strict CSP). Math text
elements save in the drawing JSON as text elements with a `subtype`, which other Excalidraw
installations render as their plain LaTeX source.

## Order

1. Ribbon, copy location (small).
2. Excalidraw fork and LaTeX.
3. Tables.
4. Comments.
5. Agents.
