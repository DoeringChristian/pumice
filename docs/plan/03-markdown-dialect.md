# 03 — Markdown dialect

Notes written for Obsidian read correctly in Pumice (**Obsidian Flavored Markdown**). The reverse is
not a goal: where one concise form can serve for several, Pumice writes that one, whether or not
Obsidian shows it, and goes on reading the others.

## Supported syntax

| Feature                                      | Syntax                                                                                   | Origin           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| CommonMark                                   | everything                                                                               | CommonMark 0.31  |
| Tables, task lists, strikethrough, autolinks | GFM                                                                                      | GFM              |
| YAML frontmatter / properties                | `---` block at file start                                                                | Obsidian         |
| Wikilinks                                    | `[[Target]]`, `[[Target\|Alias]]`                                                        | Obsidian         |
| Links to a heading or a named place          | `[[Target#Heading]]`, `[[Target#name]]`, `[[#Heading]]`; read: `[[Target#^name]]`        | Pumice, Obsidian |
| Media                                        | `![[a.png\|Caption]]{#fig-a width=50%}`, `![Caption](a.png){…}`; read: `![[a.png\|300]]` | Pumice, Obsidian |
| Embedded notes                               | `![[Target]]`, `![[Note#Heading]]`                                                       | Obsidian         |
| Names of paragraphs, list items, headings    | `{#name}` at the end of the line; read: `^name`                                          | Pumice, Obsidian |
| Tags                                         | `#tag`, `#nested/tag`, `tags:` property                                                  | Obsidian         |
| Callouts                                     | `> [!note] Title`, foldable `[!tip]-` / `[!tip]+`                                        | Obsidian         |
| Highlights                                   | `==text==`                                                                               | Obsidian         |
| Comments                                     | `%% hidden %%` (inline and block)                                                        | Obsidian         |
| Math                                         | `$inline$`, `$$block$$` (KaTeX)                                                          | Obsidian         |
| Footnotes                                    | `[^1]`, inline `^[note]`                                                                 | GFM / Obsidian   |
| Mermaid                                      | ` ```mermaid `                                                                           | Obsidian         |
| Markdown links to notes                      | `[text](Note%20name.md)`                                                                 | CommonMark       |
| HTML                                         | inline/block HTML (sanitized when rendered)                                              | CommonMark       |
| **ID links**                                 | `[[id\|Name]]`, `[[id#Heading\|Name]]`, `![[id\|Name]]`                                  | **Pumice**       |

## ID links

```markdown
---
id: k7f3qm2xa1
---

See [[r2p9dz4wn8|Meeting notes]] and the diagram ![[a8c1vn6tq3|Architecture]].
Jump to [[r2p9dz4wn8#^decisions|the decisions]].
```

- **Grammar**: same as a wikilink. The target is treated as an ID if it matches the ID pattern
  (Crockford base32, lowercase, fixed length — see [04](04-vault-identity-index.md#id-format))
  **and** that ID exists in the index. Otherwise it is resolved as a name
  (see [04](04-vault-identity-index.md#link-resolution)).
- **Inserted by the editor**: typing `[[` opens the suggester (titles, aliases, paths, headings,
  blocks); choosing an entry inserts `[[id|Name]]`. Users never type IDs.
- **Display**: live preview and reading view show only the display text. In source mode the
  `id|` part is folded into an atomic range (cursor skips it; reveal on demand).
- **Stale names**: if the target was renamed and the display text equals a former title of the
  target, the current title is displayed and a "refresh link text" quick fix is offered. Custom
  aliases are left alone. A vault command updates all stale display texts at once.
- **Plain `[[Name]]` links** remain fully supported (imported vaults, hand-typed links). A setting
  controls whether the editor converts them to ID links when resolvable ("upgrade links on edit").
- **Export / compat command**: rewrites ID links to `[[Name]]` or `[[path/Name|Alias]]` for
  Obsidian or other tools.

## Parsers

Two parsers, one dialect:

1. **Lezer** (`@lezer/markdown` + Pumice extensions) — incremental; drives CodeMirror syntax
   highlighting, live preview decorations, folding and editor-side link detection.
2. **micromark → mdast** (+ `mdast-util-*` extensions) — full AST; drives the reading view, the
   indexer (in a worker), export and plugin post-processors.

A syntax extension is registered as a **pair** through `MarkdownSyntax.register({ lezer,
micromark, mdast, toHast? })`. Registering only one half is allowed for editor-only decorations
but is flagged in dev mode.

### Conformance suite (`packages/markdown-spec`)

- Fixtures: `case.md` + `case.mdast.json` + `case.html` + `case.lezer.txt` (simplified node
  ranges).
- Sources: CommonMark spec tests, GFM spec tests, and a hand-written Obsidian-dialect corpus.
  Edge cases to cover: wikilinks in tables (`|` escaping), callouts nested in lists, `%%` spanning
  blocks, tags vs headings vs URL fragments, `==` vs setext headings, math vs dollar amounts,
  embeds with size parameters, block IDs after lists/tables.
- Runner checks that both parsers agree on the _semantic_ nodes (link targets, embed ranges, tags,
  headings, block IDs, callout boundaries, frontmatter range). Disagreement fails CI.
- Reference truth is Obsidian's own rendering: expectations for the dialect corpus are recorded
  by hand from Obsidian, not from our parsers.

## Rendering

- mdast → hast → DOM, sanitized with an allowlist; plugins may register safe extensions.
- Embeds and code blocks are rendered by contribution-point renderers, lazily, with placeholders
  sized to avoid layout shift.
- Math via KaTeX (lazy loaded), Mermaid lazy loaded.

## Live preview

Implemented as CM6 decorations driven by the Lezer tree: syntax markers hidden except on the
cursor line/selection, widgets for embeds, callouts, tables, math, checkboxes, and ID-link folding.
Each syntax extension contributes its own live-preview decorations.

## Frontmatter

- Parsed with a YAML 1.2 parser that preserves formatting and comments on round-trip (`yaml`
  package's Document API), so editing a property doesn't reformat the block.
- Reserved keys: `id` (key name configurable), `aliases`, `tags`, `cssclasses`, `title`
  (optional display title; default title is the filename, as in Obsidian).
