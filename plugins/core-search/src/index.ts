import {
  Documents,
  MetadataIndex,
  Workspace,
  definePlugin,
  type DocumentsApi,
  type IndexedFile,
  type MetadataIndexApi,
  type PluginModule,
  type SearchMatch,
  type VaultPath,
} from '@pumice/api';
import { debounce, h, highlighted } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

export interface ParsedQuery {
  /** Free words, matched by the full-text index (prefix + fuzzy). */
  words: string[];
  /** "Exact phrases", case-insensitive. */
  phrases: string[];
  /** -excluded words or phrases. */
  exclude: string[];
  tags: string[];
  paths: string[];
  files: string[];
}

/** `tag:#x path:folder file:name "a phrase" -word words`. */
export function parseQuery(query: string): ParsedQuery {
  const q: ParsedQuery = { words: [], phrases: [], exclude: [], tags: [], paths: [], files: [] };
  const re = /(-?)(?:(tag|path|file):)?(?:"([^"]*)"|(\S+))/g;
  for (const m of query.matchAll(re)) {
    const negate = m[1] === '-';
    const op = m[2];
    const value = (m[3] ?? m[4] ?? '').trim();
    if (!value) continue;
    if (negate && !op) q.exclude.push(value.toLowerCase());
    else if (op === 'tag') q.tags.push(value.replace(/^#/, '').toLowerCase());
    else if (op === 'path') q.paths.push(value.toLowerCase());
    else if (op === 'file') q.files.push(value.toLowerCase());
    else if (m[3] !== undefined) q.phrases.push(value.toLowerCase());
    else q.words.push(value);
  }
  return q;
}

function fileMatches(file: IndexedFile, q: ParsedQuery): boolean {
  const path = file.path.toLowerCase();
  if (q.paths.some((p) => !path.includes(p))) return false;
  if (
    q.files.some(
      (f) => !file.name.toLowerCase().includes(f) && !file.title.toLowerCase().includes(f),
    )
  )
    return false;
  for (const tag of q.tags) {
    const has = file.meta?.tags.some(({ tag: t }) => {
      const lower = t.toLowerCase();
      return lower === tag || lower.startsWith(`${tag}/`);
    });
    if (!has) return false;
  }
  return true;
}

function phraseSnippets(text: string, phrases: string[]): SearchMatch['snippets'] {
  const lower = text.toLowerCase();
  const out: SearchMatch['snippets'] = [];
  for (const phrase of phrases) {
    let i = lower.indexOf(phrase);
    while (i >= 0 && out.length < 3) {
      const start = Math.max(text.lastIndexOf('\n', i - 1) + 1, i - 60);
      const nl = text.indexOf('\n', i + phrase.length);
      const end = Math.min(nl < 0 ? text.length : nl, i + phrase.length + 60);
      out.push({
        text: text.slice(start, end),
        hits: [[i - start, i - start + phrase.length]],
        offset: start,
      });
      i = lower.indexOf(phrase, i + phrase.length);
    }
  }
  return out;
}

export interface SearchResultItem extends SearchMatch {
  title: string;
}

export async function runSearch(
  index: MetadataIndexApi,
  documents: DocumentsApi,
  query: string,
  limit = 100,
): Promise<SearchResultItem[]> {
  const q = parseQuery(query);
  const hasText = q.words.length || q.phrases.length;
  if (!hasText && !q.tags.length && !q.paths.length && !q.files.length) return [];
  let candidates: SearchMatch[];
  if (q.words.length || q.phrases.length) {
    candidates = await index.search([...q.words, ...q.phrases].join(' '), { limit: limit * 3 });
  } else {
    candidates = index
      .files()
      .filter((f) => f.meta)
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => ({ path: f.path, score: 0, snippets: [] }));
  }
  const out: SearchResultItem[] = [];
  for (const c of candidates) {
    const file = index.getFile(c.path);
    if (!file || !fileMatches(file, q)) continue;
    let snippets = c.snippets;
    if (q.phrases.length || q.exclude.length) {
      let text: string;
      try {
        text = await documents.read(c.path);
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      if (q.phrases.some((p) => !lower.includes(p))) continue;
      if (q.exclude.some((x) => lower.includes(x))) continue;
      if (q.phrases.length) snippets = phraseSnippets(text, q.phrases);
    }
    out.push({ ...c, snippets, title: file.title });
    if (out.length >= limit) break;
  }
  return out;
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const index = ctx.use(MetadataIndex);
    const documents = ctx.use(Documents);

    ctx.register(
      workspace.registerView({
        type: 'search',
        title: 'Search',
        icon: 'search',
        create(view) {
          const input = h('input', {
            class: 'pm-panel-input',
            type: 'search',
            placeholder: 'Search…  (tag:#x  path:dir  "phrase"  -word)',
            spellcheck: false,
            'aria-label': 'Search the vault',
          });
          input.value = ctx.settings.get('lastQuery', '');
          const summary = h('div', { class: 'pm-panel-empty' });
          const list = h('div', { class: 'pm-panel-scroll' }, summary);
          view.container.append(
            h('div', { class: 'pm-panel' }, h('div', { class: 'pm-panel-toolbar' }, input), list),
          );
          let generation = 0;

          const run = async () => {
            const gen = ++generation;
            const query = input.value;
            void ctx.settings.set('lastQuery', query);
            if (!query.trim()) {
              list.replaceChildren(
                h('div', { class: 'pm-panel-empty' }, 'Type to search note titles and contents.'),
              );
              return;
            }
            const results = await runSearch(index, documents, query);
            if (gen !== generation) return;
            list.replaceChildren(
              h(
                'div',
                { class: 'pm-panel-empty' },
                `${results.length === 100 ? '100+' : results.length} result${results.length === 1 ? '' : 's'}`,
              ),
            );
            for (const r of results) {
              list.append(
                h(
                  'button',
                  {
                    class: 'pm-panel-item pm-panel-file',
                    title: r.path,
                    onclick: (e: MouseEvent) =>
                      void workspace.openFile(r.path, { newTab: e.metaKey || e.ctrlKey }),
                  },
                  r.title,
                ),
              );
              for (const s of r.snippets) {
                list.append(
                  h(
                    'div',
                    {
                      class: 'pm-panel-item pm-panel-snippet',
                      role: 'button',
                      onclick: () =>
                        void workspace.openFile(r.path as VaultPath, {
                          state: { offset: s.offset + (s.hits[0]?.[0] ?? 0) },
                        }),
                    },
                    highlighted(s.text.trim() === s.text ? s.text : s.text, s.hits),
                  ),
                );
              }
            }
          };
          const later = debounce(() => void run(), 200);
          input.addEventListener('input', later);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') void run();
          });
          const sub = index.onDidChange(debounce(() => input.value.trim() && void run(), 1000));
          void index.ready.then(run);
          return {
            setState(state) {
              if (typeof state.query === 'string') {
                input.value = state.query;
                void run();
              }
            },
            focus() {
              input.focus();
              input.select();
            },
            dispose() {
              later.cancel();
              sub.dispose();
            },
          };
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'search',
        side: 'left',
        viewType: 'search',
        title: 'Search',
        icon: 'search',
        order: 10,
      }),
    );

    ctx.commands.register({
      id: 'search.open',
      title: 'Search in all notes',
      category: 'Search',
      hotkeys: ['Mod+Shift+F'],
      run: (query?: unknown) =>
        workspace.openView('search', {
          location: 'left',
          state: typeof query === 'string' ? { query } : {},
        }),
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
