/**
 * Obsidian compatibility report: what in an imported vault Pumice handles, and what it doesn't.
 * Pure function over file contents, so it is testable without the app.
 */

export interface VaultSnapshot {
  /** Vault-relative paths of all files, including `.obsidian/…`. */
  paths: string[];
  read(path: string): Promise<string | undefined>;
}

export interface ReportItem {
  level: 'ok' | 'info' | 'warning';
  title: string;
  detail?: string;
  examples?: string[];
}

/** Obsidian community plugins with a Pumice counterpart (built-in or planned). */
const PLUGIN_EQUIVALENTS: Record<string, string> = {
  'obsidian-excalidraw-plugin': 'Built in (core.excalidraw): drawings open and edit as they are.',
  calendar: 'Daily notes are built in; a calendar view is not yet.',
  'templater-obsidian':
    'Basic templates are built in ({{title}}, {{date}}); Templater scripts (<% … %>) are not run.',
  'obsidian-tasks-plugin':
    'Task checkboxes work; Tasks queries (```tasks blocks) are shown as code.',
  dataview: 'Not supported: ```dataview blocks are shown as code.',
  'obsidian-kanban': 'Not supported: kanban boards open as plain markdown.',
  'obsidian-outliner': 'Indent/outdent are built in; outliner gestures are not.',
  'obsidian-git': 'Not needed: Pumice merges external changes (git pulls) into open notes.',
};

const CORE_EQUIVALENTS: Record<string, string> = {
  'file-explorer': 'core.explorer',
  'global-search': 'core.search',
  switcher: 'core.switcher',
  graph: 'core.graph',
  backlink: 'core.backlinks',
  'outgoing-link': 'core.backlinks (outgoing links section)',
  'tag-pane': 'core.tags',
  'page-preview': '— (hover previews not yet)',
  'daily-notes': 'core.daily',
  templates: 'core.templates',
  'note-composer': '— (not yet)',
  'command-palette': 'core.palette',
  outline: 'core.outline',
  'word-count': 'core.editor (status bar)',
  canvas: '— (.canvas files are not supported yet)',
  bookmarks: '— (not yet)',
  properties: 'core.properties',
  sync: 'core.collab (Pumice server)',
  publish: '— (not yet)',
};

export async function obsidianReport(vault: VaultSnapshot): Promise<ReportItem[]> {
  const items: ReportItem[] = [];
  const notes = vault.paths.filter((p) => p.endsWith('.md') && !p.startsWith('.'));
  const isObsidian = vault.paths.some((p) => p.startsWith('.obsidian/'));
  items.push({
    level: 'info',
    title: `${notes.length} notes${isObsidian ? ' in an Obsidian vault' : ''}`,
    detail: isObsidian
      ? 'Notes, links, embeds, callouts, tags, properties and math work as in Obsidian.'
      : 'No .obsidian folder found.',
  });

  const json = async <T>(path: string): Promise<T | undefined> => {
    try {
      const text = await vault.read(path);
      return text ? (JSON.parse(text) as T) : undefined;
    } catch {
      return undefined;
    }
  };

  const community = (await json<string[]>('.obsidian/community-plugins.json')) ?? [];
  for (const id of community) {
    const known = PLUGIN_EQUIVALENTS[id];
    items.push({
      level: known && !known.startsWith('Not supported') ? 'ok' : 'warning',
      title: `Community plugin: ${id}`,
      detail: known ?? 'No Pumice equivalent. Its special syntax (if any) shows as plain text.',
    });
  }
  const core = await json<Record<string, boolean> | string[]>('.obsidian/core-plugins.json');
  const enabledCore = Array.isArray(core)
    ? core
    : Object.entries(core ?? {})
        .filter(([, on]) => on)
        .map(([k]) => k);
  for (const id of enabledCore) {
    const eq = CORE_EQUIVALENTS[id];
    if (!eq) continue;
    items.push({
      level: eq.startsWith('—') ? 'warning' : 'ok',
      title: `Core plugin: ${id}`,
      detail: eq.startsWith('—') ? `Not available yet${eq.slice(1)}` : `→ ${eq}`,
    });
  }

  // Syntax used in notes that Pumice doesn't interpret.
  const patterns: Array<{ re: RegExp; title: string; detail: string }> = [
    {
      re: /^```(dataview|dataviewjs)\b/m,
      title: 'Dataview queries',
      detail: 'Shown as code blocks.',
    },
    { re: /^```tasks\b/m, title: 'Tasks queries', detail: 'Shown as code blocks.' },
    {
      re: /<%[\s\S]*?%>/,
      title: 'Templater commands',
      detail: 'Left as text; only {{title}}/{{date}}/{{time}} are filled in.',
    },
    {
      re: /^\s*[\w-]+::\s/m,
      title: 'Dataview inline fields (key:: value)',
      detail: 'Kept as text; use properties (frontmatter) for metadata Pumice indexes.',
    },
    { re: /^kanban-plugin:/m, title: 'Kanban boards', detail: 'Open as plain markdown lists.' },
    {
      re: /!\[\[[^\]]+\.canvas(\|[^\]]*)?\]\]/,
      title: 'Canvas embeds',
      detail: '.canvas files are not supported yet.',
    },
  ];
  const found = new Map<string, string[]>();
  for (const path of notes.slice(0, 20000)) {
    const text = (await vault.read(path)) ?? '';
    for (const p of patterns) {
      if (p.re.test(text)) {
        const list = found.get(p.title) ?? [];
        if (list.length < 5) list.push(path);
        found.set(p.title, list);
      }
    }
  }
  for (const p of patterns) {
    const examples = found.get(p.title);
    if (examples) items.push({ level: 'warning', title: p.title, detail: p.detail, examples });
  }
  const canvases = vault.paths.filter((p) => p.endsWith('.canvas'));
  if (canvases.length)
    items.push({
      level: 'warning',
      title: `${canvases.length} canvas files`,
      detail: 'Not supported yet; they stay in the vault untouched.',
      examples: canvases.slice(0, 5),
    });
  const drawings = vault.paths.filter(
    (p) => p.endsWith('.excalidraw.md') || p.endsWith('.excalidraw'),
  );
  if (drawings.length)
    items.push({
      level: 'ok',
      title: `${drawings.length} Excalidraw drawings`,
      detail: 'Open, edit and embed as in Obsidian.',
    });
  items.push({
    level: 'info',
    title: 'Note IDs',
    detail:
      'Pumice links new notes as [[id|Name]]. Existing [[Name]] links keep working. "Assign IDs to all notes" adds an id property everywhere (optional).',
  });
  return items;
}

export function reportMarkdown(items: ReportItem[], date = new Date()): string {
  const icon = { ok: '✅', info: 'ℹ️', warning: '⚠️' } as const;
  const lines = [`# Obsidian import report`, '', `Generated ${date.toLocaleString()}.`, ''];
  for (const level of ['warning', 'ok', 'info'] as const) {
    const group = items.filter((i) => i.level === level);
    if (!group.length) continue;
    lines.push(
      `## ${level === 'warning' ? 'Needs attention' : level === 'ok' ? 'Supported' : 'Notes'}`,
      '',
    );
    for (const i of group) {
      lines.push(`- ${icon[level]} **${i.title}**${i.detail ? ` — ${i.detail}` : ''}`);
      for (const e of i.examples ?? []) lines.push(`  - [[${e.replace(/\.md$/, '')}]]`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
