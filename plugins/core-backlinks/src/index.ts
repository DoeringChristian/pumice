import {
  Documents,
  Links,
  MetadataIndex,
  Workspace,
  definePlugin,
  formatWikiLink,
  markdownText,
  type DocumentsApi,
  type MetadataIndexApi,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { createIcon, debounce, h, highlighted } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

export interface Mention {
  source: VaultPath;
  from: number;
  to: number;
  /** The line around the mention and the mention's range inside it. */
  context: string;
  range: [number, number];
}

function lineContext(
  text: string,
  from: number,
  to: number,
): { context: string; range: [number, number] } {
  let start = text.lastIndexOf('\n', from - 1) + 1;
  const nl = text.indexOf('\n', to);
  let end = nl < 0 ? text.length : nl;
  // Long lines: keep some text around the mention.
  if (from - start > 80) start = from - 80;
  if (end - to > 120) end = to + 120;
  const raw = text.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  return { context: raw.trim(), range: [from - start - lead, to - start - lead] };
}

/**
 * Replaces wikilink syntax in a snippet with what the link displays, keeping the highlighted
 * range on the same text.
 */
export function prettify(
  context: string,
  range: [number, number],
  display: (inner: string) => string,
): { context: string; range: [number, number] } {
  let out = '';
  let last = 0;
  // Original offset → new offset, for range ends outside links.
  const pieces: Array<{ start: number; end: number; newStart: number; newEnd: number }> = [];
  for (const m of context.matchAll(/!?\[\[([^\[\]\n]+)\]\]/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    out += context.slice(last, start);
    const newStart = out.length;
    out += display(m[1]!);
    pieces.push({ start, end, newStart, newEnd: out.length });
    last = end;
  }
  out += context.slice(last);
  const map = (pos: number, isEnd: boolean) => {
    let delta = 0;
    for (const p of pieces) {
      if (pos >= p.end) delta = p.newEnd - p.end;
      else if (pos > p.start || (pos === p.start && isEnd)) return isEnd ? p.newEnd : p.newStart;
      else if (pos === p.start) return p.newStart;
      else break;
    }
    return pos + delta;
  };
  return { context: out, range: [map(range[0], false), map(range[1], true)] };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Occurrences of a note's title or aliases in other notes that aren't links yet. */
export async function unlinkedMentions(
  index: MetadataIndexApi,
  documents: DocumentsApi,
  path: VaultPath,
  limit = 50,
): Promise<Mention[]> {
  const file = index.getFile(path);
  if (!file) return [];
  const names = [file.title, ...(file.meta?.aliases ?? [])].filter((n) => n.trim().length >= 3);
  if (!names.length) return [];
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  const candidates = new Set<VaultPath>();
  for (const name of names)
    for (const m of await index.search(name, { limit })) candidates.add(m.path);
  candidates.delete(path);
  const out: Mention[] = [];
  for (const source of candidates) {
    if (!source.toLowerCase().endsWith('.md')) continue;
    const meta = index.getFile(source)?.meta;
    let text: string;
    try {
      text = await documents.read(source);
    } catch {
      continue;
    }
    // Skip text inside links, code and the frontmatter.
    const skip: Array<[number, number]> = [
      ...(meta?.links ?? []).map((l) => [l.from, l.to] as [number, number]),
      ...(meta?.frontmatterRange
        ? [[meta.frontmatterRange.from, meta.frontmatterRange.to] as [number, number]]
        : []),
    ];
    for (const m of text.matchAll(pattern)) {
      const from = m.index!;
      const to = from + m[0].length;
      if (skip.some(([a, b]) => from < b && to > a)) continue;
      const before = text.slice(Math.max(0, from - 1), from);
      if (before === '`' || before === '#') continue;
      out.push({ source, from, to, ...lineContext(text, from, to) });
    }
  }
  return out;
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const index = ctx.use(MetadataIndex);
    const documents = ctx.use(Documents);
    const collapsed = new Set(ctx.settings.get<string[]>('collapsed', ['unlinked']));

    ctx.register(
      workspace.registerView({
        type: 'backlinks',
        title: 'Backlinks',
        icon: 'link',
        create(view) {
          const body = h('div', { class: 'pm-panel-scroll' });
          view.container.append(h('div', { class: 'pm-panel' }, body));
          let generation = 0;

          const section = (
            id: string,
            title: string,
            count: number | undefined,
            fill: (el: HTMLElement) => void,
          ) => {
            const isCollapsed = collapsed.has(id);
            const content = h('div', {});
            const heading = h(
              'div',
              {
                class: 'pm-panel-heading',
                role: 'button',
                tabindex: '0',
                onclick: () => {
                  if (collapsed.has(id)) collapsed.delete(id);
                  else collapsed.add(id);
                  void ctx.settings.set('collapsed', [...collapsed]);
                  void render();
                },
              },
              createIcon(isCollapsed ? 'chevron-right' : 'chevron-down', 12),
              title,
              count !== undefined ? h('span', { class: 'pm-panel-count' }, String(count)) : null,
            );
            body.append(h('div', { class: 'pm-panel-section' }, heading, content));
            if (!isCollapsed) fill(content);
          };

          const mentionList = (
            el: HTMLElement,
            mentions: Mention[],
            action?: (m: Mention) => HTMLElement,
          ) => {
            if (!mentions.length) {
              el.append(h('div', { class: 'pm-panel-empty' }, 'None.'));
              return;
            }
            const bySource = new Map<VaultPath, Mention[]>();
            for (const m of mentions)
              bySource.set(m.source, [...(bySource.get(m.source) ?? []), m]);
            for (const [source, list] of bySource) {
              el.append(
                h(
                  'button',
                  {
                    class: 'pm-panel-item pm-panel-file',
                    onclick: (e: MouseEvent) =>
                      void workspace.openFile(source, { newTab: e.metaKey || e.ctrlKey }),
                  },
                  index.getFile(source)?.title ?? source,
                ),
              );
              for (const m of list) {
                el.append(
                  h(
                    'div',
                    {
                      class: 'pm-panel-item pm-panel-snippet',
                      role: 'button',
                      onclick: () => void workspace.openFile(source, { state: { offset: m.from } }),
                    },
                    action ? action(m) : null,
                    highlighted(m.context, [m.range]),
                  ),
                );
              }
            }
          };

          const render = async () => {
            const gen = ++generation;
            const path = workspace.activeFile;
            body.replaceChildren();
            if (!path || !index.getFile(path)) {
              body.append(h('div', { class: 'pm-panel-empty' }, 'No note open.'));
              return;
            }
            const linked: Mention[] = [];
            for (const r of index.backlinks(path)) {
              if (r.source === path) continue;
              let text = '';
              try {
                text = await documents.read(r.source);
              } catch {
                continue;
              }
              const raw = lineContext(text, r.link.from, r.link.to);
              const links = ctx.tryUse(Links);
              const pretty = prettify(raw.context, raw.range, (inner) => {
                const pipe = /\\?\|/.exec(inner);
                const alias = pipe ? inner.slice(pipe.index + pipe[0].length) : undefined;
                const main = pipe ? inner.slice(0, pipe.index) : inner;
                const hash = main.indexOf('#');
                const target = hash >= 0 ? main.slice(0, hash) : main;
                const subpath = hash >= 0 ? main.slice(hash + 1) : undefined;
                return (
                  links?.displayText(
                    {
                      target,
                      ...(subpath ? { subpath } : {}),
                      ...(alias !== undefined ? { alias } : {}),
                    },
                    r.source,
                  ) ??
                  alias ??
                  main
                );
              });
              linked.push({ source: r.source, from: r.link.from, to: r.link.to, ...pretty });
            }
            if (gen !== generation) return;
            const outgoing = index.outgoing(path);
            body.replaceChildren();
            section('linked', 'Linked mentions', linked.length, (el) => mentionList(el, linked));
            section('outgoing', 'Outgoing links', outgoing.length, (el) => {
              if (!outgoing.length) el.append(h('div', { class: 'pm-panel-empty' }, 'None.'));
              for (const r of outgoing) {
                const label = r.target
                  ? (index.getFile(r.target)?.title ?? r.target)
                  : r.link.target;
                el.append(
                  h(
                    'button',
                    {
                      class: `pm-panel-item${r.target ? '' : ' is-unresolved'}`,
                      title: r.target ?? `Not found: ${r.link.target}`,
                      onclick: () => {
                        const links = ctx.tryUse(Links);
                        if (links)
                          void links.openLink(r.link.target, {
                            sourcePath: path,
                            ...(r.link.subpath ? { subpath: r.link.subpath } : {}),
                          });
                        else if (r.target) void workspace.openFile(r.target);
                      },
                    },
                    label + (r.link.subpath ? ` › ${r.link.subpath}` : ''),
                    r.target ? null : h('span', { class: 'pm-panel-badge' }, 'unresolved'),
                  ),
                );
              }
            });
            section('unlinked', 'Unlinked mentions', undefined, (el) => {
              el.append(h('div', { class: 'pm-panel-empty' }, 'Searching…'));
              void unlinkedMentions(index, documents, path).then((mentions) => {
                if (gen !== generation) return;
                el.replaceChildren();
                mentionList(el, mentions, (m) =>
                  h(
                    'button',
                    {
                      class: 'pm-panel-button pm-panel-badge',
                      title: 'Turn this mention into a link',
                      onclick: (e: MouseEvent) => {
                        e.stopPropagation();
                        void linkMention(m, path);
                      },
                    },
                    'Link',
                  ),
                );
              });
            });
          };

          const linkMention = async (m: Mention, target: VaultPath) => {
            const links = ctx.tryUse(Links);
            const handle = await documents.open(m.source);
            try {
              const ytext = markdownText(handle.doc);
              const text = ytext.toString();
              const shown = text.slice(m.from, m.to);
              if (shown.toLowerCase() !== m.context.slice(m.range[0], m.range[1]).toLowerCase())
                return;
              // `[[Name]]`, with the mention's own wording as display text when it differs.
              const name = index.getFile(target)!.name;
              const alias = shown === name ? {} : { alias: shown };
              const link = links
                ? links.formatLink(target, alias)
                : formatWikiLink({ target: name, ...alias });
              handle.doc.transact(() => {
                ytext.delete(m.from, m.to - m.from);
                ytext.insert(m.from, link);
              });
            } finally {
              handle.dispose();
            }
          };

          const later = debounce(() => void render(), 250);
          const subs = [
            workspace.onDidChangeActiveFile(() => void render()),
            index.onDidChange(later),
          ];
          void render();
          return { dispose: () => (later.cancel(), subs.forEach((s) => s.dispose())) };
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'backlinks',
        side: 'right',
        viewType: 'backlinks',
        title: 'Backlinks',
        icon: 'link',
        order: 10,
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
