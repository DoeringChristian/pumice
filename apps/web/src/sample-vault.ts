/** Content of the in-browser demo vault. */
export const sampleVault: Record<string, string> = {
  'Welcome.md': `---
tags: [pumice, start]
aliases: [Start here]
---
# Welcome to Pumice

Pumice is a **local-first**, *extensible* markdown editor. Everything you see — the editor, the
file explorer, search, backlinks — is a plugin.

## Try it

- Press **⌘/Ctrl + O** to jump to a note, **⌘/Ctrl + P** for the command palette.
- Type \`[[\` to link a note, like [[Architecture]]. Renaming a note updates its links.
- **⌘/Ctrl + E** switches between editing and the reading view.
- **⌘/Ctrl + Shift + F** searches all notes. Try \`tag:#idea\`.

### Tasks

- [x] Write the plan
- [x] Build the kernel and plugin host
- [x] Wikilinks and backlinks
- [ ] Excalidraw

> [!tip] Plain files
> Notes are plain markdown files in a folder. Edits made by other programs are merged in.

Inline \`code\`, ~~strikethrough~~, ==highlights==, #tags, math like $e^{i\\pi} + 1 = 0$ and
[external links](https://example.com) render in place. %%Comments like this one stay hidden.%%

\`\`\`ts
export const plugin = definePlugin({
  activate(ctx) {
    ctx.commands.register({ id: 'hello', title: 'Say hello', run: () => console.log('hi') });
  },
});
\`\`\`

---

The roadmap, embedded:

![[Roadmap#Milestones]]
`,
  'Architecture.md': `---
id: a7chtk3ctr
tags: [pumice]
---
# Architecture

The kernel only knows about plugins, services and commands. See the [[Welcome]] note.

![[Attachments/plugins.svg|360]]

A drawing, embedded:

![[Sketch.excalidraw]]

## Core plugins

1. core.vault — the file tree
2. core.documents — Yjs documents backed by files
3. core.markdown, core.index — the dialect and the metadata index
4. core.workspace, core.editor, core.reader — the UI

\`\`\`mermaid
graph LR
  Kernel --> Vault --> Documents --> Editor
  Documents --> Index --> Backlinks
\`\`\`

> [!note]- How links resolve
> 1. by path, 2. by name, 3. by alias, as in Obsidian. ^resolution

$$
\\text{links} = \\sum_{n \\in \\text{notes}} \\text{outgoing}(n)
$$
`,
  'Projects/Pumice/Roadmap.md': `# Roadmap

## Milestones

| Milestone | Status |
| --- | --- |
| M0 Foundations | done |
| M1 Editing core | done |
| M2 Linking & knowledge | in progress |
| M3 Excalidraw | planned |

## Notes

Decisions are recorded in [[Architecture#Core plugins]].[^1]

[^1]: The optional Note IDs plugin adds links by ID, like [[a7chtk3ctr|this one]], which keep
    working when a note is renamed outside the app.
`,
  'Projects/Pumice/Ideas.md': `# Ideas

- Graph view #idea
- Daily notes #idea/later
- Publish to the web #idea/later
- An idea about the architecture of plugins.
`,
  'Daily/2026-10-31.md': `# 2026-10-31

Worked on the [[Roadmap]]. Mentioned Architecture without linking it.
`,
  'Sketch.excalidraw.md': `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
Kernel ^txt1

Plugins → [[Welcome]] ^txt2

## Element Links
box2: [[Architecture]]

%%
## Drawing
\`\`\`json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://pumice.app",
  "elements": [
    {
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#ffc9c9",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": {
        "type": 3
      },
      "seed": 11,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "id": "box1",
      "type": "rectangle",
      "x": 40,
      "y": 40,
      "width": 220,
      "height": 90,
      "index": "a0"
    },
    {
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": null,
      "seed": 12,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "id": "txt1",
      "type": "text",
      "x": 70,
      "y": 70,
      "width": 160,
      "height": 25,
      "index": "a1",
      "text": "Kernel",
      "originalText": "Kernel",
      "fontSize": 20,
      "fontFamily": 5,
      "textAlign": "left",
      "verticalAlign": "top",
      "containerId": null,
      "autoResize": true,
      "lineHeight": 1.25
    },
    {
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#a5d8ff",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": {
        "type": 3
      },
      "seed": 13,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": "[[Architecture]]",
      "locked": false,
      "id": "box2",
      "type": "ellipse",
      "x": 340,
      "y": 40,
      "width": 200,
      "height": 90,
      "index": "a2"
    },
    {
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": null,
      "seed": 14,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "id": "txt2",
      "type": "text",
      "x": 372,
      "y": 72,
      "width": 150,
      "height": 25,
      "index": "a3",
      "text": "Plugins \\u2192 [[Welcome]]",
      "originalText": "Plugins \\u2192 [[Welcome]]",
      "fontSize": 16,
      "fontFamily": 5,
      "textAlign": "left",
      "verticalAlign": "top",
      "containerId": null,
      "autoResize": true,
      "lineHeight": 1.25
    },
    {
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": {
        "type": 2
      },
      "seed": 15,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "id": "arr1",
      "type": "arrow",
      "x": 262,
      "y": 85,
      "width": 76,
      "height": 0,
      "index": "a4",
      "points": [
        [
          0,
          0
        ],
        [
          76,
          0
        ]
      ],
      "startArrowhead": null,
      "endArrowhead": "arrow"
    }
  ],
  "appState": {
    "gridSize": null,
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
\`\`\`
%%`,
  'Attachments/plugins.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120"><rect width="360" height="120" rx="12" fill="#f2e4dc"/><g font-family="sans-serif" font-size="14" fill="#2b2723"><rect x="20" y="40" width="90" height="40" rx="8" fill="#e3825a"/><text x="38" y="65">kernel</text><rect x="135" y="40" width="90" height="40" rx="8" fill="#fff"/><text x="152" y="65">plugins</text><rect x="250" y="40" width="90" height="40" rx="8" fill="#fff"/><text x="275" y="65">you</text></g></svg>`,
};
