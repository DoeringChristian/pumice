import {
  Bibliography,
  Editor,
  MetadataIndex,
  Reader,
  SettingsUi,
  ShellService,
  Vault,
  citedKeys,
  definePlugin,
  type BibliographyApi,
  type CitationStyle,
  type PluginModule,
} from '@pumice/api';
import { h, select, settingItem, textInput } from '@pumice/ui';
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
            container.replaceChildren(
              h('h2', {}, 'Bibliography'),
              settingItem(
                'Bibliography file',
                'The BibTeX file notes cite from, as a path in the vault (references.bib). A note can name its own with a "bibliography" property. Empty: the .bib files at the top of the vault.',
                textInput(
                  ctx.settings.get('file', ''),
                  (v) => {
                    void ctx.settings.set('file', v.trim());
                    store.touch();
                  },
                  { placeholder: 'references.bib' },
                ),
              ),
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
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
