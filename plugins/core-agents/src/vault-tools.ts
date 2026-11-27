import type { DrawingsApi, MetadataIndexApi, VaultApi, VaultPath } from '@pumice/api';
import type { AgentFiles } from './session';

/**
 * The tools every assistant works on the vault with, defined once: the built-in ChatGPT
 * assistant calls them as functions, the agent programs (Claude Code, Codex, ...) through the
 * "pumice" MCP server over their connection (note-tools.ts), in a window or on a server. Each
 * goes through the chat's own file access (its view of what it read, its name on its changes).
 * What differs between them comes in as `ToolCall`: asking before a change, showing it.
 */

/** A tool as models are told about it. */
export interface ToolSpec {
  name: string;
  description: string;
  /** Its arguments, as a JSON schema. */
  parameters: Record<string, unknown>;
}

/** What the tools work with. */
export interface VaultToolContext {
  files: AgentFiles;
  vault: VaultApi;
  /** Search and links (absent: those tools are not offered). */
  index?: MetadataIndexApi;
  /** Drawings (absent: their tools are not offered). */
  drawings?: DrawingsApi;
}

/** A change a tool is about to make. */
export interface ToolChange {
  path: VaultPath;
  /** What it was ('' for a new file) and what it becomes. */
  oldText: string;
  newText: string;
}

/** What the caller does around a tool. */
export interface ToolCall {
  /** Before a change is made: shows it, asks if that is the chat's way. Throws if refused. */
  beforeWrite(title: string, change: ToolChange): Promise<void>;
}

export interface ToolResult {
  text: string;
  /** A picture of a drawing, for those who can look at it (a `data:` PNG). */
  picture?: { path: VaultPath; url: string };
}

export interface VaultTool extends ToolSpec {
  /** It changes the vault. */
  writes: boolean;
  /** How it is shown in a chat. */
  kind: 'read' | 'edit' | 'search';
  title(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: VaultToolContext, call: ToolCall): Promise<ToolResult>;
}

/** How notes are written in Pumice: for every assistant, with the tools. */
export const NOTES_GUIDE = `Use the tools to look things up before answering questions about the notes; do not guess their contents. Paths are relative to the vault, with forward slashes, e.g. "Projects/Plan.md".
When you change notes, make small, exact edits with edit_note and keep the user's wording and formatting elsewhere. Link to other notes with [[Name]] wikilinks. Answer in Markdown, briefly. When your answer mentions a note, link it, [[Name]] or [[Name#Heading]], or give the line as Projects/Plan.md:12: the user can click these.
Media is written ![Caption](file.png) or ![[file.png|Caption]] (the same thing; files of the vault or addresses on the web: pictures, videos, sound, PDFs, HTML frames, drawings), with attributes right behind it, without a space: {#fig-loss width=50%}. Widths are shares of the text's width. Several on one line stand beside each other. A plot is a Plotly figure in a file of its own ("results/loss.plotly.json", JSON as Plotly writes it: {"data": [...], "layout": {...}}), shown with ![[results/loss.plotly.json|Caption]]; never write a figure's data into a note.
Figures, tables and equations are numbered by the app: a figure is numbered if it has a caption or a label; a table gets a "Table: …" line above it. Label what you refer to: {#fig-loss} behind media, {#tab-runs} at the end of the "Table: …" line, {#eq-energy} behind the $$ that closes a formula, and "label: fig-setup" as a line of a frame block. Refer to it with @fig-loss, which reads "Figure 2"; never write the number yourself.`;

export const DRAWING_GUIDE = `Drawings are Excalidraw files ("Name.excalidraw"; older ones "Name.excalidraw.md"); a note shows one with ![[Name.excalidraw]] (a caption and a width as for a picture). read_drawing tells you what is in a drawing and edit_drawing answers with the drawing as it is afterwards and with notes on its layout (what overlaps, arrows that go through boxes or cross, boxes almost but not quite in line, uneven gaps); both are followed by a picture of the drawing as it looks. Look at the picture after each change and go on until it looks right and no layout notes are left: nothing overlapping or cut off, arrows not through boxes, boxes in line (align) and evenly spaced (distribute). Never change a drawing with edit_note or create_note. Choose the kind of diagram the content has: a flowchart for steps and decisions (boxes for steps, diamonds for decisions with their arrows labelled "yes" and "no", one direction, top to bottom unless it is a pipeline); boxes in rows or columns for parts and layers; things around a centre only for a mind map. For anything with a direction, add the boxes and the arrows and pass arrange ("down" or "right") instead of working out coordinates: it puts every element a step after those that lead to it. Where you place things yourself, plan the layout as coordinates first: boxes of one row at the same y, one column at the same x, at least 60 apart. Give elements ids that say what they are; join boxes with arrows by id instead of placing lines by hand; keep labels short. Drawings have a math mode: write formulas and symbols in texts and labels as LaTeX between $…$ ($\\omega_0$, $\\frac{a}{b}$), not as plain letters or Unicode.`;

const NOTE_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_notes',
    description: 'Lists files in the vault (paths). Optionally only those under a folder.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder path; omit for the whole vault.' },
      },
    },
  },
  {
    name: 'search_notes',
    description:
      'Full-text search over note titles and contents. Returns matching paths with excerpts.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'read_note',
    description: 'Reads a note (or any text file) from the vault.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'get_links',
    description: 'Lists the notes a note links to and the notes that link to it (backlinks).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'edit_note',
    description:
      'Replaces one exact piece of text in a note. old_text must occur exactly once; include enough surrounding text to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'create_note',
    description:
      "Creates a new text file: a note (Markdown), or another file such as a frame's HTML or a JSON data file. Fails if the file exists.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
];

const COLOR = 'A colour as CSS: "#e03131", "transparent".';
const DRAWING_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_drawing',
    description:
      'Lists what is in a drawing (an Excalidraw file, "….excalidraw" or "….excalidraw.md"): each element with its id, kind, place, size and text, what each arrow joins, and notes on the layout (overlaps). Read a drawing before changing it.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'edit_drawing',
    description:
      'Changes a drawing, or makes a new one if the path (ending in ".excalidraw") does not exist. Give all changes of one step together: they are applied in order, all or none. Coordinates are pixels, x to the right and y downwards; x and y are the top left corner. Lay shapes out on a grid with room between them (about 60 or more) and join them with arrows by id: an arrow between two elements finds its own way and follows them when they move. Shapes grow to hold their label. The answer lists what is wrong with the layout (overlaps, arrows through boxes or across each other, boxes nearly but not quite in line, uneven gaps): fix it, with align and distribute where they do it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        arrange: {
          type: 'string',
          enum: ['down', 'right'],
          description:
            'Lays out everything the arrows join as a flowchart after the operations: each element one step after those that lead to it, steps going down (or to the right), arrows at right angles, arrows that lead back going around. With this you need not give x and y for the boxes: add the boxes and the arrows and let them be arranged. Use it for flowcharts, pipelines, hierarchies and anything else with a direction; leave it out to keep positions as they are.',
        },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'add',
                  'update',
                  'delete',
                  'align',
                  'distribute',
                  'group',
                  'ungroup',
                  'order',
                ],
                description:
                  'add: a new element (needs type). update: change the given properties of the element with this id. delete: remove it (its label goes with it). align: bring the elements in ids to one line (needs align). distribute: give the elements in ids (three or more) equal gaps (needs direction). group / ungroup: make the elements in ids move as one. order: put the elements in ids in front of or behind the others (needs position). Arrows follow the elements they join.',
              },
              id: {
                type: 'string',
                description:
                  'The element (update, delete). For add: an id of your choice to refer to it later (letters, digits, - and _), e.g. "client".',
              },
              ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'The elements for align, distribute, group, ungroup and order.',
              },
              align: {
                type: 'string',
                enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'],
                description:
                  'align: left, center or right puts the elements in one column (same left edge, same centre line, same right edge); top, middle or bottom in one row.',
              },
              direction: {
                type: 'string',
                enum: ['horizontal', 'vertical'],
                description: 'distribute: along a row (horizontal) or a column (vertical).',
              },
              gap: {
                type: 'number',
                description:
                  'distribute: the gap between neighbours. Left out, the outer two stay and the others are spread evenly between them.',
              },
              position: { type: 'string', enum: ['front', 'back'], description: 'order.' },
              type: {
                type: 'string',
                enum: ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line'],
              },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              text: {
                type: 'string',
                description:
                  'The text of a text element, or the label in a shape or on an arrow. Break long labels into lines yourself (\\n). Empty removes a label. Formulas are LaTeX between $…$ ("$E = mc^2$", "rate $\\gamma$").',
              },
              from: { type: 'string', description: 'Arrows: the id of the element it starts at.' },
              to: { type: 'string', description: 'Arrows: the id of the element it ends at.' },
              points: {
                type: 'array',
                items: { type: 'array', items: { type: 'number' } },
                description:
                  'Lines, and arrows not between two elements: the [x, y] points it goes through. On an arrow between two elements: points between its ends to bend it around something.',
              },
              stroke: { type: 'string', description: COLOR },
              fill: { type: 'string', description: COLOR },
              strokeStyle: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
              strokeWidth: { type: 'number' },
              fontSize: { type: 'number', description: 'Default 20.' },
              startArrowhead: { type: 'string', enum: ['none', 'arrow', 'triangle', 'dot', 'bar'] },
              endArrowhead: { type: 'string', enum: ['none', 'arrow', 'triangle', 'dot', 'bar'] },
              opacity: { type: 'number', description: '0 to 100.' },
              route: {
                type: 'string',
                enum: ['elbow', 'straight'],
                description:
                  'Arrows between two elements: "elbow" (the default) runs at right angles from side to side, as in a flowchart; "straight" is one line between them, as in a mind map or a graph.',
              },
              math: {
                type: 'boolean',
                description:
                  'Whether the text is set in math mode (LaTeX between $…$). Left out: on when the text has a $…$ in it. Give false for a text with dollar signs that are not formulas.',
              },
            },
            required: ['op'],
          },
        },
      },
      required: ['path', 'operations'],
    },
  },
];

const MAX_READ = 60_000;

/**
 * A path in the vault: relative to it (or absolute inside `root`, as agent programs speak), with
 * forward slashes; nothing outside it, nothing of the app's settings.
 */
export function vaultPath(value: unknown, root = ''): VaultPath {
  let p = String(value ?? '').replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && p.startsWith(`${base}/`)) p = p.slice(base.length + 1);
  p = p.replace(/^\/+/, '').replace(/^\.\//, '');
  if (!p || p.split('/').some((part) => part === '..' || part === '.'))
    throw new Error('Give a path inside the vault, like "Folder/Note.md".');
  if (p === '.pumice' || p.startsWith('.pumice/'))
    throw new Error('That folder holds app settings.');
  return p;
}

const spec = (specs: ToolSpec[], name: string): ToolSpec => specs.find((t) => t.name === name)!;

/**
 * An argument that must be given as text (it may be empty): a missing one is an error, never
 * taken for '' (an edit without its new text would delete).
 */
function given(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Error(`Give ${name} (text).`);
  return value;
}
const at = (args: Record<string, unknown>, ctx: VaultToolContext) =>
  vaultPath(args.path, ctx.files.root);

/** A picture of a drawing to go with an answer, if one can be made. */
async function picture(
  ctx: VaultToolContext,
  path: VaultPath,
  text: string,
): Promise<Pick<ToolResult, 'picture'> & { note: string }> {
  try {
    const url = await ctx.drawings!.picture(path, text);
    return {
      picture: { path, url },
      note: '\n\nA picture of the drawing follows: look at it, and fix what does not look right.',
    };
  } catch {
    return { note: '\n\n(No picture could be made of the drawing.)' };
  }
}

const NOTE_TOOLS: VaultTool[] = [
  {
    ...spec(NOTE_TOOL_SPECS, 'list_notes'),
    writes: false,
    kind: 'read',
    title: (args) => `List ${args.folder ? String(args.folder) : 'notes'}`,
    async run(args, { vault, files }) {
      const folder = args.folder ? vaultPath(args.folder, files.root).replace(/\/+$/, '') : '';
      const paths = vault
        .files()
        .map((f) => f.path)
        .filter((p) => !folder || p.startsWith(`${folder}/`))
        .sort();
      if (!paths.length)
        return { text: folder ? `No files under ${folder}.` : 'The vault is empty.' };
      const shown = paths.slice(0, 500);
      return {
        text:
          shown.join('\n') +
          (paths.length > shown.length ? `\n… and ${paths.length - shown.length} more` : ''),
      };
    },
  },
  {
    ...spec(NOTE_TOOL_SPECS, 'search_notes'),
    writes: false,
    kind: 'search',
    title: (args) => `Search “${String(args.query ?? '')}”`,
    async run(args, { index }) {
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));
      const hits = await index!.search(given(args, 'query'), { limit });
      if (!hits.length) return { text: 'No matches.' };
      return {
        text: hits
          .map((h) => `${h.path}\n${h.snippets.map((s) => `  … ${s.text.trim()} …`).join('\n')}`)
          .join('\n\n'),
      };
    },
  },
  {
    ...spec(NOTE_TOOL_SPECS, 'read_note'),
    writes: false,
    kind: 'read',
    title: (args) => `Read ${String(args.path ?? '')}`,
    async run(args, ctx) {
      const path = at(args, ctx);
      if (ctx.drawings?.isDrawing(path))
        return {
          text: `This is a drawing; change it with edit_drawing, not edit_note.\n\n${ctx.drawings.describe(path, await ctx.files.read(path))}`,
        };
      const text = await ctx.files.read(path);
      return {
        text:
          text.length > MAX_READ
            ? `${text.slice(0, MAX_READ)}\n\n[Truncated: the note has ${text.length} characters.]`
            : text || '(empty note)',
      };
    },
  },
  {
    ...spec(NOTE_TOOL_SPECS, 'get_links'),
    writes: false,
    kind: 'read',
    title: (args) => `Links of ${String(args.path ?? '')}`,
    async run(args, ctx) {
      const path = at(args, ctx);
      const index = ctx.index!;
      if (!index.getFile(path)) throw new Error(`No such note: ${path}`);
      const out = [
        ...new Set(index.outgoing(path).map((l) => l.target ?? `${l.link.target} (missing)`)),
      ];
      const back = [...new Set(index.backlinks(path).map((l) => l.source))];
      return {
        text: `Links to:\n${out.join('\n') || '(none)'}\n\nLinked from:\n${back.join('\n') || '(none)'}`,
      };
    },
  },
  {
    ...spec(NOTE_TOOL_SPECS, 'edit_note'),
    writes: true,
    kind: 'edit',
    title: (args) => `Edit ${String(args.path ?? '')}`,
    async run(args, ctx, call) {
      const path = at(args, ctx);
      if (ctx.drawings?.isDrawing(path))
        throw new Error('This is a drawing: change it with edit_drawing.');
      const oldText = given(args, 'old_text');
      const newText = given(args, 'new_text');
      const text = await ctx.files.read(path);
      const first = oldText ? text.indexOf(oldText) : -1;
      if (first < 0)
        throw new Error(
          'old_text was not found in the note. Read the note and copy the text exactly.',
        );
      if (text.indexOf(oldText, first + 1) >= 0)
        throw new Error('old_text occurs more than once. Include more surrounding text.');
      const next = text.slice(0, first) + newText + text.slice(first + oldText.length);
      await call.beforeWrite(`Edit ${path}`, { path, oldText: text, newText: next });
      await ctx.files.write(path, next);
      return { text: `Edited ${path}.` };
    },
  },
  {
    ...spec(NOTE_TOOL_SPECS, 'create_note'),
    writes: true,
    kind: 'edit',
    title: (args) => `Create ${String(args.path ?? '')}`,
    async run(args, ctx, call) {
      const path = at(args, ctx);
      if (ctx.vault.get(path))
        throw new Error(`${path} already exists. Use edit_note to change it.`);
      const content = given(args, 'content');
      await call.beforeWrite(`Create ${path}`, { path, oldText: '', newText: content });
      await ctx.files.write(path, content);
      return { text: `Created ${path}.` };
    },
  },
];

const DRAWING_TOOLS: VaultTool[] = [
  {
    ...spec(DRAWING_TOOL_SPECS, 'read_drawing'),
    writes: false,
    kind: 'read',
    title: (args) => `Look at ${String(args.path ?? '')}`,
    async run(args, ctx) {
      const drawings = ctx.drawings!;
      const path = at(args, ctx);
      if (!drawings.isDrawing(path)) throw new Error(`${path} is not a drawing.`);
      const text = await ctx.files.read(path);
      const { note, ...shown } = await picture(ctx, path, text);
      return { text: drawings.describe(path, text) + note, ...shown };
    },
  },
  {
    ...spec(DRAWING_TOOL_SPECS, 'edit_drawing'),
    writes: true,
    kind: 'edit',
    title: (args) => `Draw in ${String(args.path ?? '')}`,
    async run(args, ctx, call) {
      const drawings = ctx.drawings!;
      const path = at(args, ctx);
      if (!drawings.isDrawing(path))
        throw new Error('A drawing is a file that ends in ".excalidraw".');
      const arrange =
        args.arrange === 'down' || args.arrange === 'right' ? args.arrange : undefined;
      const operations = Array.isArray(args.operations) ? args.operations : [];
      if (!operations.length && !arrange) throw new Error('Give the operations.');
      const before = ctx.vault.get(path) ? await ctx.files.read(path) : undefined;
      const { text, summary } = drawings.edit(path, before, operations, arrange ? { arrange } : {});
      // What changes, as the two lists of what is in the drawing.
      await call.beforeWrite(`${before === undefined ? 'Create' : 'Change'} the drawing ${path}`, {
        path,
        oldText: before === undefined ? '' : drawings.describe(path, before),
        newText: drawings.describe(path, text),
      });
      await ctx.files.write(path, text);
      const { note, ...shown } = await picture(ctx, path, text);
      return {
        text: `${summary}\n\nThe drawing now:\n${drawings.describe(path, text)}${note}`,
        ...shown,
      };
    },
  },
];

/** The tools there are with what `ctx` has (without those that change anything: `readOnly`). */
export function vaultTools(ctx: VaultToolContext, opts: { readOnly?: boolean } = {}): VaultTool[] {
  return [...NOTE_TOOLS, ...(ctx.drawings ? DRAWING_TOOLS : [])].filter(
    (t) =>
      (!opts.readOnly || !t.writes) &&
      (ctx.index || (t.name !== 'search_notes' && t.name !== 'get_links')),
  );
}

/** What the assistants are told about the tools there are. */
export function vaultGuide(ctx: VaultToolContext): string {
  return [NOTES_GUIDE, ctx.drawings ? DRAWING_GUIDE : ''].filter(Boolean).join('\n\n');
}
