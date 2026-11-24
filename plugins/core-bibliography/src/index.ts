import {
  Bibliography,
  Editor,
  MetadataIndex,
  Reader,
  SettingsUi,
  ShellService,
  Vault,
  Workspace,
  citedKeys,
  parseBibtex,
  definePlugin,
  type BibliographyApi,
  type CitationStyle,
  type PluginModule,
} from '@pumice/api';
import { button, h, select, settingItem } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { bibliographyExtension } from './editor-ext';
import { citeText, citedOf, inBrackets, referenceLine, referencesElement } from './render';
import { BibStore } from './store';
import './bibliography.css';

export const manifest = manifestJson;
export { BibStore } from './store';

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const index = ctx.use(MetadataIndex);
    const editor = ctx.use(Editor);
    const workspace = ctx.use(Workspace);
    const shell = ctx.tryUse(ShellService);
    const style = (): CitationStyle =>
      ctx.settings.get<string>('style', 'numeric') === 'author-year' ? 'author-year' : 'numeric';
    const store = new BibStore(vault, index, () => ctx.settings.get('file', ''));
    const openUrl = (url: string) => {
      if (/^https?:/i.test(url)) void shell?.openExternal(url);
    };

    const api: BibliographyApi = {
      entries: (note) => store.entries(note),
      ready: (note) => store.ready(note),
      fileOf: (note, key) => store.fileOf(note, key),
      style,
      onDidChange: store.onDidChange,
    };
    ctx.provide(Bibliography, api);

    ctx.register(
      vault.onDidChange((changes) =>
        store.invalidate(
          changes.flatMap((c) =>
            c.type === 'delete'
              ? [c.path]
              : c.type === 'rename'
                ? [c.oldPath, c.entry.path]
                : [c.entry.path],
          ),
        ),
      ),
    );
    // A note's `bibliography` property may have changed.
    ctx.register(index.onDidChange(() => store.touch()));

    ctx.register(
      editor.registerExtension((ectx) => bibliographyExtension({ bib: api, openUrl }, ectx)),
    );

    // Rendered notes (embedded notes, slides, exports): citations read as in the editor, and
    // a whole note ends with its list of references.
    const reader = ctx.tryUse(Reader);
    if (reader)
      ctx.register(
        reader.registerPostProcessor(async (root, rctx) => {
          const marks = [...root.querySelectorAll<HTMLElement>('.pm-cite[data-key]')].filter(
            // (Not those of a note embedded in this one: they are its own.)
            (el) => !el.parentElement?.closest('.pm-embed-body') || rctx.depth > 0,
          );
          if (!marks.length) return;
          await store.ready(rctx.sourcePath);
          const entries = store.entries(rctx.sourcePath);
          if (!entries.size) return;
          // Numbered as in the whole note, of which this may be a part.
          const inNote = index.getFile(rctx.sourcePath)?.meta?.citations ?? [];
          const here = marks.map((el) => el.dataset.key!);
          const keys = rctx.whole ? here : [...new Set([...inNote, ...here])];
          const cited = citedOf(
            rctx.whole ? citedKeys(here.map((k) => `@${k}`).join(' ')) : keys,
            entries,
            style(),
          );
          for (const el of marks) {
            const entry = entries.get(el.dataset.key!);
            if (!entry) continue;
            let before = '';
            for (let n = el.previousSibling; n; n = n.previousSibling)
              before = (n.textContent ?? '') + before;
            el.textContent = citeText(cited, entry, inBrackets(before));
            el.title = referenceLine(entry);
            el.classList.add('is-resolved');
            if (entry.url) el.addEventListener('click', () => openUrl(entry.url!));
          }
          if (rctx.whole && cited.list.length) {
            root.querySelector(':scope > .pm-references')?.remove();
            root.append(referencesElement(cited, openUrl));
          }
        }),
      );

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'bibliography',
          title: 'Bibliography',
          group: 'plugins',
          render(container) {
            const isBib = (path: string) => /\.bib(tex)?$/i.test(path);
            const choose = (path: string) => {
              void ctx.settings.set('file', path);
              store.touch();
            };
            // What a new file starts with: an entry to write the next one after.
            const example = [
              '% References for the notes of this vault, as BibTeX. Cite one with @key.',
              '',
              '@article{doe2020,',
              '  author  = {Doe, Jane and Roe, Richard},',
              '  title   = {An example entry},',
              '  journal = {Journal of Examples},',
              '  year    = {2020},',
              '}',
              '',
            ].join('\n');
            const create = async () => {
              if (!vault.get('references.bib')) await vault.create('references.bib', example);
              choose('references.bib');
              draw();
              void workspace.openFile('references.bib', { newTab: true });
            };
            // A file from the computer is copied into the vault (never over one that is there).
            const picker = h('input', { type: 'file', accept: '.bib,.bibtex', hidden: true });
            picker.addEventListener('change', async () => {
              const file = picker.files?.[0];
              picker.value = '';
              if (!file) return;
              const text = await file.text();
              const name = file.name.replace(/\.bib(tex)?$/i, '') || 'references';
              const path = vault.availablePath('', name, 'bib');
              await vault.create(path, text);
              choose(path);
              draw();
            });
            const draw = () => {
              const files = vault
                .files()
                .map((f) => f.path)
                .filter(isBib)
                .sort();
              const chosen = ctx.settings.get('file', '').trim();
              const missing = !!chosen && !files.includes(chosen);
              const options: Array<[string, string]> = [
                ['', 'All .bib files at the top of the vault'],
                ...files.map((f): [string, string] => [f, f]),
                ...(missing ? [[chosen, `${chosen} (not found)`] as [string, string]] : []),
              ];
              const used =
                chosen && !missing ? [chosen] : chosen ? [] : files.filter((f) => !f.includes('/'));
              const status = h('div', { class: 'pm-bib-status' });
              const show = async () => {
                const rows: HTMLElement[] = [];
                for (const path of used) {
                  const count = parseBibtex(await vault.read(path).catch(() => '')).length;
                  rows.push(
                    h(
                      'div',
                      { class: 'pm-bib-file' },
                      h('span', { class: 'pm-bib-file-name' }, path),
                      h(
                        'span',
                        { class: 'pm-bib-file-count' },
                        `${count} ${count === 1 ? 'entry' : 'entries'}`,
                      ),
                      button('Open', () => void workspace.openFile(path, { newTab: true })),
                    ),
                  );
                }
                status.replaceChildren(
                  ...(rows.length
                    ? rows
                    : [
                        h(
                          'div',
                          { class: 'pm-bib-none' },
                          missing
                            ? `${chosen} is not in the vault.`
                            : 'No bibliography file yet: create one, or add one from your computer.',
                        ),
                      ]),
                );
              };
              void show();
              container.replaceChildren(
                h('h2', {}, 'Bibliography'),
                settingItem(
                  'Bibliography file',
                  'The BibTeX file notes cite from. A note can name its own with a "bibliography" property.',
                  select<string>(
                    chosen,
                    options,
                    (v) => {
                      choose(v);
                      draw();
                    },
                    'Bibliography file',
                  ),
                ),
                status,
                settingItem(
                  'Add a bibliography',
                  'Start an empty references.bib in the vault, or copy a .bib file from your computer into it.',
                  h(
                    'div',
                    { class: 'pm-bib-actions' },
                    button(
                      vault.get('references.bib') ? 'Use references.bib' : 'Create references.bib',
                      () => void create(),
                    ),
                    button('Add a file…', () => picker.click()),
                    picker,
                  ),
                ),
                styleSetting(),
              );
            };
            const styleSetting = () =>
              settingItem(
                'Citation style',
                'How @key reads in a note.',
                select<CitationStyle>(
                  style(),
                  [
                    ['numeric', 'Numbers: [1]'],
                    ['author-year', 'Author and year: Doe et al. (2020)'],
                  ],
                  (v) => {
                    void ctx.settings.set('style', v);
                    store.touch();
                  },
                  'Citation style',
                ),
              );
            draw();
            // A file was added, taken away or written in while the settings are open.
            return vault.onDidChange((changes) => {
              if (
                changes.some(
                  (c) =>
                    isBib(c.type === 'delete' ? c.path : c.entry.path) ||
                    (c.type === 'rename' && isBib(c.oldPath)),
                )
              )
                draw();
            });
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
