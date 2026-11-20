import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  Editor,
  SettingsUi,
  definePlugin,
  editorCompletions,
  type PluginModule,
} from '@pumice/api';
import { h, settingItem } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { allSnippets, expand, parseSnippets, snippetBefore } from './snippets';

export const manifest = manifestJson;

/** Not in code or math, where a colon is just a colon. */
const inPlainText = (state: EditorState, pos: number) => {
  for (let node = syntaxTree(state).resolveInner(pos, -1); ;) {
    if (/Code|Math|Frontmatter|URL/.test(node.name)) return false;
    if (!node.parent) return true;
    node = node.parent;
  }
};

export const plugin = definePlugin({
  activate(ctx) {
    const editor = ctx.use(Editor);
    const snippets = () => allSnippets(parseSnippets(ctx.settings.get('snippets', '')));

    const insert = (view: EditorView, from: number, to: number, text: string) => {
      const out = expand(text);
      view.dispatch({
        changes: { from, to, insert: out.text },
        selection: { anchor: from + out.cursor },
        userEvent: 'input.complete',
      });
    };

    ctx.register(
      editor.registerExtension(() => [
        // The closing colon of `:name:` writes the snippet.
        EditorView.inputHandler.of((view, from, to, text) => {
          if (text !== ':' || from !== to || view.state.readOnly) return false;
          const line = view.state.doc.lineAt(from);
          const found = snippetBefore(line.text.slice(0, from - line.from), snippets());
          if (!found || !inPlainText(view.state, from)) return false;
          insert(view, line.from + found.start, to, found.snippet.text);
          return true;
        }),
        // While the name is being typed, the snippets that match are offered.
        editorCompletions.of((context: CompletionContext): CompletionResult | null => {
          const before = context.matchBefore(/(?:^|[\s([{>"']):[A-Za-z][\w-]*$/);
          if (!before || !inPlainText(context.state, context.pos)) return null;
          const from = before.from + before.text.indexOf(':');
          return {
            from,
            validFor: /^:[\w-]*$/,
            options: snippets().map((s, i) => ({
              label: `:${s.name}:`,
              detail: s.description ?? expand(s.text).text.replace(/\n/g, ' ↵ ').slice(0, 40),
              boost: -i,
              apply: (view: EditorView, _c, start: number, end: number) => {
                // A closing colon typed already goes with it.
                const after = view.state.doc.sliceString(end, end + 1) === ':' ? 1 : 0;
                insert(view, start, end + after, s.text);
              },
            })),
          };
        }),
      ]),
    );

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'snippets',
          title: 'Snippets',
          group: 'app',
          order: 30,
          render(container) {
            const area = h('textarea', {
              class: 'pm-text-input pm-snippets-input',
              rows: 8,
              spellcheck: false,
              placeholder:
                'sig = Best regards,\\nChristian\nmeeting = ## Meeting {{date}}\\n\\n- {{cursor}}',
              'aria-label': 'Your snippets',
            });
            area.value = ctx.settings.get('snippets', '');
            area.style.width = '100%';
            area.style.fontFamily = 'var(--font-mono)';
            area.addEventListener('change', () => void ctx.settings.set('snippets', area.value));
            container.replaceChildren(
              h('h2', {}, 'Snippets'),
              h(
                'p',
                { class: 'pm-setting-note' },
                'Typing a name between colons writes its text, for example :today:. One snippet per line as "name = text". In the text, \\n is a line break, {{date}} and {{time}} are filled in (also {{date:D MMMM YYYY}} or {{date+7}}), and {{cursor}} is where the cursor goes.',
              ),
              settingItem(
                'Your snippets',
                'They come before the built-in ones of the same name.',
                null,
              ),
              area,
              h('h3', {}, 'Built in'),
              h(
                'p',
                { class: 'pm-setting-note' },
                allSnippets([])
                  .map((s) => `:${s.name}: → ${expand(s.text).text}`)
                  .join('   ·   '),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
