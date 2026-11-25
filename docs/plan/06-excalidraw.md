# 06 — Excalidraw plugin (`core.excalidraw`)

A core plugin that makes drawings first-class notes: they have IDs, can be linked and embedded,
can contain links, show up in backlinks and graph, and can be edited collaboratively.

## Library

- `@excalidraw/excalidraw` (MIT), React component, **pinned version**, wrapped in our own adapter
  module so upgrades touch one place.
- Loaded as a lazy chunk on first open/embed of a drawing (it's several MB with fonts).
- Fonts (Excalifont/Virgil, Nunito, Comic Shanns, Cascadia, …) bundled locally — works offline.
- Theme follows the app (light/dark), via the app's CSS variables where Excalidraw allows it.

## File formats

| Format                                                | Read      | Write                        | Notes                              |
| ----------------------------------------------------- | --------- | ---------------------------- | ---------------------------------- |
| `*.excalidraw.md` (Obsidian Excalidraw plugin format) | ✓         | ✓                            | compatibility with existing vaults |
| `*.excalidraw` (plain Excalidraw JSON)                | ✓         | ✓ (default for new drawings) | vault pictures in `embeddedFiles`  |
| `.excalidraw.svg` / `.png` with embedded scene        | ✓ (later) | export only                  |                                    |

`.excalidraw.md` structure (to be confirmed against real files from current plugin versions,
captured as fixtures in `plugins/core-excalidraw/fixtures/`):

````markdown
---
excalidraw-plugin: parsed
tags: [excalidraw]
id: a8c1vn6tq3 # Pumice ID, added like any other note
---

==⚠ Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements

Some label ^Xk2Lp9aB
See [[r2p9dz4wn8|Meeting notes]] ^Qw81mZtC

## Embedded Files

5c1f…: [[diagram-image.png]]

%%

## Drawing

```compressed-json
N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYDGBA… (LZ-string, base64)
```

%%
````

- Parse: frontmatter, text-element section (gives searchable text and block IDs per element),
  embedded-files map, and the scene (compressed or plain JSON).
- Write: regenerate the sections from the scene, keep unknown frontmatter keys and unknown
  sections verbatim, compress by default (setting).
- Round-trip test: open → save without changes must produce byte-identical output for fixtures
  from the Obsidian plugin (or a documented normalisation).

## Document codec

Drawings use the same `Documents` service as notes but with their own **codec** (a contribution
point of `core.documents`: file type ↔ Y.Doc structure):

```
Y.Doc (drawing)
  Y.Text "frontmatter"            raw YAML text
  Y.Map  "elements": elementId → element object (plain JSON, replaced as a whole)
  Y.Map  "files":    fileId    → { blob: sha256 | vaultPath, mimeType }
  Y.Map  "meta":     background color, grid, etc. (shared appState subset)
```

- Element-level last-writer-wins using Excalidraw's own `version` / `versionNonce` (the same
  reconciliation Excalidraw uses for its collaboration), so concurrent edits to _different_
  elements always merge, and edits to the _same_ element resolve deterministically.
- Element order uses Excalidraw's fractional `index` property — no array CRDT needed.
- Per-user appState (zoom, scroll, selection, tool) is never in the doc; selection and pointer are
  shared via awareness.
- External file edits: parse the scene and reconcile element-wise by version (no text merge).

## Views and embeds

- **Drawing view**: registered for the `excalidraw` file type; full editor; toggle to "markdown
  view" for the raw file.
- **Embeds** `![[id|Name]]` in notes: rendered as SVG via `exportToSvg`, cached in app storage by
  scene hash; click to open, hover for quick preview. Options as in Obsidian (`|400` width,
  `#area=…` / frame references later).
- Embeds in reading view, live preview and in other drawings (drawing-in-drawing as image).
- Export: SVG, PNG (with optional embedded scene), copy to clipboard.

## Links

- Text elements containing `[[...]]` and the element `link` property are links. Typing `[[` in a
  text element or the link dialog uses the same suggester as the editor and inserts ID links.
- An indexer extractor registers drawing links, block IDs (`^elementId`) and text so drawings
  appear in backlinks, graph and search.
- Links _to_ elements: `[[drawingId#^elementId|label]]` opens the drawing zoomed to that element.
- Images from the vault are referenced by vault file ID (shared vaults) or path (local), not
  copied into the scene.

## Collaboration

- Uses the codec above with `CollabProvider`; live pointers, selections and "follow user" via
  awareness.
- Image blobs go through the vault blob store (shared vaults), so they're deduplicated with
  attachments.

## Mobile

- Excalidraw supports touch and stylus (Apple Pencil, Android stylus); verify pen-only drawing mode
  and palm rejection in the S1 spike.
- Embeds use cached SVGs; the editor chunk loads only when a drawing is opened.

## Scope v1

In: view/edit, both file formats, embeds in notes, links in/out with ID links, index integration,
collaboration, export SVG/PNG, light/dark.
Later: embedding live notes inside drawings (Excalidraw embeddables), frames as link targets,
scripting/automation API, LaTeX in drawings, PDF annotation.
