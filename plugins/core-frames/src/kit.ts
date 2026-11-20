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
  var KEY=${JSON.stringify(HOST_KEY)},settings={},theme={dark:false,vars:{}},listeners=[];
  try{settings=JSON.parse(decodeURIComponent(location.hash.slice(1))||'{}')||{}}catch(e){}
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
    /** Tells the note how tall the content is (done automatically when the content changes size). */
    resize:resize
  };
  addEventListener('message',function(e){
    if(e.source!==parent||!e.data||e.data.type!=='pumice-theme')return;
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

  Pumice provides the theme (CSS variables such as --text, --border, --accent, --series-1…6),
  base styles, and window.pumice.settings (the other keys of the block). See FOLDER/README.md.
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
export function styleGuide(folder: string): string {
  const dir = folder || '(the vault root)';
  const at = folder ? `${folder}/` : '';
  return `# Frames

A frame is an HTML file shown inside a note: a visualization, an interactive figure, a small
tool. This file says how to write one. Follow it so that all frames look like one system.

## Where things go

- One folder per frame: \`${at}<name>/index.html\`, lowercase names with dashes. Libraries and
  other assets sit beside \`index.html\` and are loaded by relative path. Frames have no network
  access by default: never load anything from a CDN.
- **Never paste HTML, scripts or data into a note.** The note only references the files.
- Write a frame once and reuse it: everything that differs between uses (which data, labels,
  options) is a setting, not a copy of the file.
- Data goes in its own file (JSON, CSV, an image, a binary) next to the note or in the
  attachments folder, and is passed to the frame as a setting.

## Showing a frame in a note

Without settings:

    ![[${at}<name>/index.html]]

With settings, a \`frame\` block (YAML). \`file\`, \`caption\` and \`height\` are reserved; every
other key is the frame's own setting. A value that is exactly one \`[[link]]\` to a vault file
arrives as a URL the frame can \`fetch\` or use as \`src\`:

    \`\`\`frame
    file: [[${at}field/index.html]]
    caption: Pressure field, run 12
    data: [[runs/field-12.json]]
    colormap: viridis
    \`\`\`

Without \`height\` the frame is as tall as its content. Give \`height\` (pixels) for content
that fills its window, such as a WebGL canvas.

## Inside the HTML file

Pumice adds the theme, base styles and \`window.pumice\` before the file's own content:

- \`pumice.settings\`: the block's settings as an object (links already turned into URLs).
- \`pumice.theme.dark\`, \`pumice.onTheme(fn)\`: light or dark, and a callback when it changes.
- \`pumice.color('--accent')\`: a theme color as a string, for canvas and WebGL.
- \`pumice.series()\`: the six data series colors, in order.
- \`pumice.resize()\`: report a new content height (automatic when the layout changes).

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
Rules: never put HTML, scripts or data in the note itself. Write the HTML once as ${at}<name>/index.html (lowercase, dashes; libraries beside it, no CDN: frames have no network), keep data in its own file, and reference both from the note with a frame block:

\`\`\`frame
file: [[${at}<name>/index.html]]
caption: …
data: [[path/to/data.json]]
anyOtherSetting: value
\`\`\`

(or just ![[${at}<name>/index.html]] when there are no settings). Reuse an existing frame with new settings instead of writing a similar one; look in ${at || 'the frames folder'} first. Inside the file, read window.pumice.settings (links arrive as fetchable URLs) and style only with the theme's CSS variables.
Before writing or changing a frame, read ${at}README.md and follow it exactly (if it is missing, ask the user to run the "Frames: write the style guide" command, or follow these rules: transparent page background; colors only from var(--text), --text-muted, --border, --bg-elevated, --accent and --series-1…6; font var(--font-ui) at 13px; plain unstyled buttons/inputs/tables; must work in light and dark).`;
}
