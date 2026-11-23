/**
 * What Pumice adds to every HTML file it shows as a frame, so that frames look like the rest
 * of the app without each one restating the theme: the theme's variables, quiet base styles,
 * and `window.pumice`. It is put before the file's own content, so the file can override it.
 */

/** Theme variables handed to frames (names as in the app's theme). */
export const THEME_VARS = [
  '--font-ui',
  '--font-text',
  '--font-mono',
  '--bg',
  '--bg-panel',
  '--bg-hover',
  '--bg-active',
  '--bg-elevated',
  '--border',
  '--text',
  '--text-muted',
  '--text-faint',
  '--accent',
  '--accent-soft',
  '--accent-text',
  '--link',
  '--danger',
  '--selection',
  '--code-bg',
];

/** Colors for data series, in order; told apart in both themes. */
export const SERIES = {
  light: ['#c8582e', '#2f7f8f', '#7a8f3a', '#8a5aa8', '#c9952b', '#5b6f9e'],
  dark: ['#e3825a', '#5fb3c4', '#a9bf63', '#b58ad1', '#e0b354', '#8ea3d6'],
};

export interface FrameTheme {
  dark: boolean;
  vars: Record<string, string>;
}

/** The key of the settings object that carries the theme (never a setting of the file). */
export const HOST_KEY = '$pumice';

const BASE_CSS = `
:root{--font-ui:system-ui,sans-serif;--font-mono:ui-monospace,Menlo,monospace;--bg:#faf9f7;--bg-panel:#f2f0ec;--bg-hover:rgba(60,45,30,.06);--bg-elevated:#fff;--border:#e4e0d9;--text:#2b2723;--text-muted:#7a726a;--text-faint:#a8a097;--accent:#c8582e;--accent-soft:rgba(200,88,46,.12);--accent-text:#fff;--link:#b4532c;--danger:#c43c3c;--code-bg:rgba(60,45,30,.06);--radius:6px;${SERIES.light
  .map((c, i) => `--series-${i + 1}:${c}`)
  .join(';')}}
html{background:transparent}
body{margin:0;padding:12px;background:transparent;color:var(--text);font:13px/1.5 var(--font-ui);-webkit-font-smoothing:antialiased}
*,*::before,*::after{box-sizing:border-box}
h1,h2,h3,h4{margin:0 0 8px;font-weight:600;line-height:1.3}
h1{font-size:18px}h2{font-size:16px}h3{font-size:14px}h4{font-size:13px}
p{margin:0 0 8px}
a{color:var(--link)}
small,.muted{color:var(--text-muted)}
code,pre{font-family:var(--font-mono);font-size:12px;background:var(--code-bg);border-radius:4px}
code{padding:1px 4px}pre{padding:8px 10px;overflow:auto}
button,input,select,textarea{font:inherit;color:inherit}
button,select,input[type=text],input[type=number]{height:26px;padding:0 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elevated)}
button{cursor:pointer}button:hover{background:var(--bg-hover)}
button.primary{border-color:var(--accent);background:var(--accent);color:var(--accent-text)}
input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--accent)}
label{color:var(--text-muted)}
table{border-collapse:collapse}th,td{padding:4px 8px;border-bottom:1px solid var(--border);text-align:left}th{color:var(--text-muted);font-weight:600}
canvas,svg,img,video{max-width:100%}
.panel{padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elevated)}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
`;

const SCRIPT = `
(function(){
  var KEY=${JSON.stringify(HOST_KEY)},settings={},theme={dark:false,vars:{}},listeners=[],followers=[];
  try{settings=window.__pumiceSettings||JSON.parse(decodeURIComponent(location.hash.slice(1))||'{}')||{}}catch(e){}
  if(settings[KEY]){theme=settings[KEY];delete settings[KEY]}
  function apply(t){
    var root=document.documentElement;
    for(var k in (t.vars||{}))root.style.setProperty(k,t.vars[k]);
    root.style.colorScheme=t.dark?'dark':'light';
    root.dataset.theme=t.dark?'dark':'light';
  }
  function resize(){
    parent.postMessage({type:'pumice-frame-size',height:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*');
  }
  apply(theme);
  window.pumice={
    settings:settings,
    theme:theme,
    /** Calls back when the app switches between light and dark. */
    onTheme:function(f){listeners.push(f)},
    /** A theme color as the browser computed it, for canvas and WebGL: pumice.color('--accent'). */
    color:function(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim()},
    /** The data series colors, in order. */
    series:function(){var out=[];for(var i=1;i<=6;i++)out.push(window.pumice.color('--series-'+i));return out},
    /**
     * Calls back with the new settings when they change while the frame is shown (a file was
     * dropped onto it, the block was edited). A frame that uses this is not reloaded for such
     * changes: pumice.onSettings(function(settings){ redraw(settings) }).
     */
    onSettings:function(f){
      followers.push(f);
      if(followers.length===1)parent.postMessage({type:'pumice-frame-live'},'*');
    },
    /** Tells the note how tall the content is (done automatically when the content changes size). */
    resize:resize,
    /** Changes settings and keeps them in the note: pumice.update({colormap:'magma'}); null removes one. */
    update:function(patch){
      for(var k in patch){if(patch[k]===null||patch[k]===undefined)delete settings[k];else settings[k]=patch[k]}
      parent.postMessage({type:'pumice-frame-update',settings:patch},'*');
    }
  };
  addEventListener('message',function(e){
    if(e.source!==parent||!e.data)return;
    if(e.data.type==='pumice-settings'){
      // The same object, so code that kept a reference to pumice.settings sees the change.
      for(var k in settings)delete settings[k];
      for(var n in e.data.settings)settings[n]=e.data.settings[n];
      followers.forEach(function(f){try{f(settings)}catch(err){console.error(err)}});
      return;
    }
    if(e.data.type!=='pumice-theme')return;
    theme=e.data.theme;window.pumice.theme=theme;apply(theme);
    listeners.forEach(function(f){try{f(theme)}catch(err){console.error(err)}});
  });
  addEventListener('load',function(){
    resize();
    if(window.ResizeObserver)new ResizeObserver(resize).observe(document.documentElement);
  });
})();
`;

/** The HTML put in front of a frame's own content. */
export const FRAME_KIT = `<style data-pumice>${BASE_CSS}</style><script data-pumice>${SCRIPT}</script>`;

/** A file's HTML with the kit in place: right after `<head>`, or else at the very start. */
export function withKit(html: string, kit = FRAME_KIT): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + kit + html.slice(head.index + head[0].length)
    );
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + kit + html.slice(at);
}

/** What a new frame starts from. */
export const TEMPLATE = `<!doctype html>
<meta charset="utf-8" />
<title>NAME</title>
<!--
  A Pumice frame. Shown in a note with  ![[NAME.html]]  or a frame block:

      \`\`\`frame
      file: [[FOLDER/NAME/index.html]]
      caption: What this shows
      title: Hello
      \`\`\`

  Settings (every other key of the block; list each one here with its type and default):
    title   text, default: none   A heading above the content.

  A frame is general: name it after what it does, and take everything about a particular
  dataset from the settings. Pumice provides the theme (CSS variables such as --text, --border,
  --accent, --series-1…6), base styles, and window.pumice.settings. See FOLDER/README.md.
-->
<style>
  /* Only what this frame adds; colors and fonts come from the theme. */
  .value { font-size: 22px; font-weight: 600; color: var(--accent); }
</style>

<h3 id="title"></h3>
<div class="panel row">
  <span class="muted">Settings received</span>
  <code id="settings"></code>
</div>

<script>
  // Opened outside Pumice (a browser, Obsidian), window.pumice is missing: fall back.
  const settings = window.pumice ? pumice.settings : {};
  document.getElementById('title').textContent = settings.title ?? 'NAME';
  document.getElementById('settings').textContent = JSON.stringify(settings);
</script>
`;

/**
 * How frames are written. Given to the agents and saved as the frames folder's README, so
 * that every frame looks and behaves like part of the app.
 */
export const GUIDE_VERSION = 7;

export function styleGuide(folder: string): string {
  const dir = folder || '(the vault root)';
  const at = folder ? `${folder}/` : '';
  return `<!-- pumice-frames-guide: ${GUIDE_VERSION} -->
# Frames

A frame is an HTML file shown inside a note: a visualization, an interactive figure, a small
tool. This file says how to write one. Follow it so that all frames look like one system.

## A frame is a tool, not a picture of one dataset

This is the rule that matters most. A frame shows **a kind of thing** (a mesh, a time series,
two images to compare, a table of runs). The particular thing it shows comes from the note,
through settings. Asked to "show the Lucy mesh", the right result is a **mesh viewer** and a
block that passes Lucy to it; the wrong result is a "Lucy viewer".

- Name the frame after what it does: \`mesh-viewer\`, \`line-chart\`, \`image-compare\`,
  \`volume-slices\`. Never after the data (\`lucy\`, \`run-12\`, \`figure-3\`).
- Nothing about one dataset is written into the HTML: no file names, titles, labels, units,
  axis ranges, camera positions, or colors picked for particular series. Each of these is a
  setting with a sensible default, or is worked out from the data (fit the camera to the
  bounding box, take axis ranges from the values).
- Accept the usual formats of the kind and tell them apart by file extension or content (a mesh
  viewer reads \`.obj\`, \`.ply\`, \`.stl\`, \`.glb\`), and accept one item or a list where that
  makes sense (\`meshes:\` with a label each).
- Show a clear message inside the frame when a setting is missing or a file cannot be read,
  naming the setting. Never show a blank frame.
- **Before writing a frame, look at what exists**: list \`${at}\` and read the header of each
  candidate. If one fits, use it. If one nearly fits, add a setting to it (keeping the old
  behavior as the default) rather than writing a second, similar frame.
- Say what the frame takes: start \`index.html\` with a comment that lists every setting, its
  type, its default and one example block. The next use starts from that comment.

So "show X" is three steps:

1. Find or write the general frame for that kind of data.
2. Put the data in its own file (\`data/\`, the attachments folder, or next to the note). Data
   from the web is downloaded into the vault, not linked.
3. Put a \`frame\` block in the note that names the frame, the data and a caption.

    \`\`\`frame
    file: [[${at}mesh-viewer/index.html]]
    caption: Lucy, 250k triangles
    mesh: [[data/lucy-250k.ply]]
    up: z
    \`\`\`

A second mesh in another note is then one more block, with no new HTML.

## When the reader drops a file onto a frame

There is nothing to implement for it: no drop handler, no file picker. The app does it.

1. The reader drags a file from the file list onto the frame.
2. The app checks the frame's \`frame.json\` (below): the file's type must be listed.
3. The app writes the file into the block in the note: appended to the list of the \`setting\`
   named there if the frame takes several (\`"multiple": true\`), replacing it otherwise.
4. The frame gets the new settings: \`pumice.settings.<setting>\` now has one more address at
   the end. By default the frame is loaded anew, so a frame that draws everything from
   \`pumice.settings\` at start needs no code for this at all. A frame with state worth keeping
   (a camera, a selection) registers \`pumice.onSettings(fn)\` and updates itself instead.

So a comparison viewer treats its list in order: the first item is the reference, the others
are what was added. To let the reader remove or reorder items, draw the controls in the frame
and call \`pumice.update({ <setting>: newList })\` with the addresses it was given.

## Offering a frame as a viewer for a file type

A general frame can also open whole files: clicking a \`.ply\` file in the file list then shows
it in the mesh viewer, in a tab. To offer that, put a \`frame.json\` beside \`index.html\`:

    {
      "name": "Mesh viewer",
      "opens": { "extensions": ["ply", "obj", "stl", "glb"], "setting": "mesh" }
    }

For a frame that compares or combines several files, add \`"multiple": true\`: the setting is
then always a list (also with one file), and the user can pick several files when inserting the
frame into a note.

Describe the frame's other settings in the same file. The app offers them, with their
description and values, to whoever writes a block for the frame:

    "settings": {
      "up": { "description": "Which axis points up", "values": ["y", "z"], "default": "z" },
      "wireframe": "Draw the edges (true or false)",
      "texture": { "description": "An image to map onto the mesh", "type": "file" }
    }

\`name\` is what the user sees when choosing a viewer. \`extensions\` are the file endings
without the dot. \`setting\` is the setting the opened file arrives as (default \`data\`); it is
the same setting a \`frame\` block would pass, so one frame serves notes and tabs alike. Opened
this way the frame fills the tab: lay it out for any size, and do not rely on other settings
being present.

Add a \`frame.json\` whenever a frame's main input is a single file of a recognizable type.
The app's own viewers stay the default for the types they already open (pictures, PDFs,
notes); the user can switch with "Open with…".

## Where things go

- One folder per frame: \`${at}<name>/index.html\`, lowercase names with dashes. Libraries and
  other assets sit beside \`index.html\` and are loaded by relative path. Frames have no network
  access by default: never load anything from a CDN.
- **Never paste HTML, scripts or data into a note.** The note only references the files.
- Data goes in its own file (JSON, CSV, an image, a binary) next to the note or in the
  attachments folder, and is passed to the frame as a setting.

## Showing a frame in a note

Without settings:

    ![[${at}<name>/index.html]]

With settings, a \`frame\` block (YAML). \`file\`, \`caption\`, \`width\` and \`height\` are reserved; every
other key is the frame's own setting. A value that is exactly one \`[[link]]\` to a vault file
arrives as a URL the frame can \`fetch\` or use as \`src\`:

    \`\`\`frame
    file: [[${at}field/index.html]]
    caption: Pressure field, run 12
    data: [[runs/field-12.json]]
    colormap: viridis
    \`\`\`

A file on the web is referred to the same way, as a Markdown link or in angle brackets; it
arrives as an address the frame can load although frames have no network access:

    mesh: [Lucy](https://example.org/models/lucy.ply)
    more:
      - [[data/local.ply]]
      - <https://example.org/models/bunny.ply>

A bare address (\`link: https://example.org\`) stays ordinary text.

Without \`height\` the frame is as tall as its content. Give \`height\` (pixels) for content
that fills its window, such as a WebGL canvas.

## Inside the HTML file

Pumice adds the theme, base styles and \`window.pumice\` before the file's own content:

- \`pumice.settings\`: the block's settings as an object (links already turned into URLs).
- \`pumice.theme.dark\`, \`pumice.onTheme(fn)\`: light or dark, and a callback when it changes.
- \`pumice.color('--accent')\`: a theme color as a string, for canvas and WebGL.
- \`pumice.series()\`: the six data series colors, in order.
- \`pumice.onSettings(fn)\`: called with the new settings when they change while the frame is
  shown. Without it the frame is simply loaded anew with the new settings.
- \`pumice.resize()\`: report a new content height (automatic when the layout changes).
- \`pumice.update({ key: value })\`: change settings from inside the frame and keep them in the
  note (the block is rewritten); \`null\` removes a setting. Use it for what the reader chooses
  in the frame and would expect to find again: an item removed from a comparison, the order of
  the items, a colormap. The frame is not reloaded for its own updates, so apply the change
  yourself as well. To remove or reorder files, pass back the addresses you were given. A
  frame cannot add files this way; the reader adds them by dragging them onto the frame.

The settings are also the JSON in the URL fragment
(\`JSON.parse(decodeURIComponent(location.hash.slice(1)))\`), so a frame can run without
Pumice. Guard for that: \`const settings = window.pumice ? pumice.settings : {}\`.

## Style

- **Colors only from the theme**: \`--bg\`, \`--bg-panel\`, \`--bg-elevated\`, \`--bg-hover\`,
  \`--border\`, \`--text\`, \`--text-muted\`, \`--text-faint\`, \`--accent\`, \`--accent-soft\`,
  \`--link\`, \`--danger\`, \`--code-bg\`. Data series use \`--series-1\` … \`--series-6\` in that
  order. No hex colors of your own, except inside a colormap for scalar data.
- The page background is transparent: the frame sits on the note. Do not set a background on
  \`html\` or \`body\`. Use \`.panel\` (bordered, elevated) to set something apart.
- Fonts: \`--font-ui\` for everything, \`--font-mono\` for numbers in tables and code. Body text
  is 13px; do not go below 11px. Headings are already sized; at most one \`h3\` as a title,
  and usually none, because the block's \`caption\` labels the figure.
- Buttons, selects, inputs, range sliders, tables, \`code\` and \`.row\` (a wrapping flex row
  with gaps) are already styled. Use them plainly, without restyling. \`button.primary\` is the
  one main action.
- Spacing in steps of 4px (4, 8, 12, 16). Corners \`var(--radius)\`. Lines 1px \`var(--border)\`.
  No shadows, no gradients, no decoration.
- Charts: thin axes in \`--border\`, labels in \`--text-muted\` at 11–12px, data in the series
  colors, a legend only when there is more than one series. Redraw on \`pumice.onTheme\`.
- Both themes must work. Never assume a light background.
- Lay out with flex or grid and percentages so the frame works from 320px to 1200px wide.
  Never use \`100vh\` for the page height without a \`height\` in the block.
- Keep it quiet: no animation unless it shows the data, no sound, nothing that runs before the
  reader interacts with it if it is heavy.

Folder for frames in this vault: \`${dir}\`.
`;
}

/** The short version sent to an agent with each conversation. */
export function agentGuidance(folder: string): string {
  const at = folder ? `${folder}/` : '';
  return `Pumice can show HTML inside notes ("frames"): interactive figures, visualizations, small tools. Use a frame when a note needs something Markdown, a table, a Mermaid diagram or a drawing cannot show.

A frame is a reusable tool for a KIND of data, never a page about one dataset. Asked to "show the Lucy mesh", you write (or reuse) a general mesh viewer and pass Lucy to it; you do not write a Lucy viewer. Concretely:
- Name the frame after what it does (mesh-viewer, line-chart, image-compare), never after the data.
- Nothing specific to one dataset goes into the HTML: no file names, titles, labels, units, ranges or camera positions. Those are settings with defaults, or are worked out from the data.
- First list ${at || 'the frames folder'} and read the header comment of existing frames. Reuse one that fits; extend one that nearly fits with a new setting instead of writing a similar second frame.
- Start index.html with a comment listing every setting (type, default) and an example block, and describe the settings in frame.json too ("settings": {"up": {"description": "…", "values": ["y", "z"], "default": "z"}}): the app suggests them while a block is written.

Steps for "show X": (1) find or write the general frame, as ${at}<name>/index.html with its libraries beside it (frames have no network access: download libraries and data into the vault, never link a CDN); (2) put the data in its own file; (3) reference both from the note. Never put HTML, scripts or data in the note itself:

\`\`\`frame
file: [[${at}mesh-viewer/index.html]]
caption: Lucy, 250k triangles
mesh: [[data/lucy-250k.ply]]
\`\`\`

A frame whose main input is one file of some type should also offer itself as the viewer for that type: put frame.json beside index.html, {"name": "Mesh viewer", "opens": {"extensions": ["ply", "obj"], "setting": "mesh"}} (add "multiple": true if it compares several files; the setting is then always a list). Such files then open in a tab through the frame, which gets the file as that setting and fills the tab. The reader adds files by dragging them onto the frame: the app writes them into the block (appended to that setting's list) and the frame gets the new settings, reloaded by default or through pumice.onSettings(fn) if it registered one; never write a drop handler or a file picker. pumice.update({key: value}) lets the frame change its own settings in the note (remove or reorder items, options the reader picks).\n\nfile, caption, width and height are reserved; every other key is a setting. Inside the file, read window.pumice.settings (a value that is one [[link]], or a web resource written [label](https://…) or <https://…>, arrives as a fetchable URL) and style only with the theme's CSS variables. With no settings, ![[${at}<name>/index.html]] also works.
Before writing or changing a frame, read ${at}README.md and follow it exactly. If it is missing, follow these rules: transparent page background; colors only from var(--text), --text-muted, --border, --bg-elevated, --accent and --series-1…6; font var(--font-ui) at 13px; plain unstyled buttons/inputs/tables; must work in light and dark; show a message in the frame when a setting is missing.`;
}
