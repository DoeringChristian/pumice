import {
  Documents,
  MarkdownSyntax,
  MetadataIndex,
  Reader,
  SettingsUi,
  Vault,
  Workspace,
  definePlugin,
  type PluginModule,
} from '@pumice/api';
import { button, calloutStyle, createIcon, h, settingItem, textInput, toggle } from '@pumice/ui';
import 'katex/dist/katex.min.css';
import '@pumice/ui/video.css';
import manifestJson from '../manifest.json';
import { DEFAULT_PREAMBLE, ReaderImpl } from './reader';
import './reader.css';

export { ReaderImpl, sectionOf } from './reader';

export const manifest = manifestJson;

/** Decorates callouts with their icon and color (shared with the editor's live preview). */
export function decorateCallout(el: HTMLElement): void {
  const { icon, color } = calloutStyle(el.dataset.callout ?? 'note');
  el.classList.add(`callout-${color}`);
  const slot = el.querySelector('.callout-icon');
  if (slot && !slot.firstChild) slot.append(createIcon(icon, 16));
  const fold = el.querySelector('.callout-fold');
  if (fold && !fold.firstChild) fold.append(createIcon('chevron-down', 14));
}

const PREAMBLE_TEMPLATE = `% LaTeX preamble: what is defined here can be used in every formula of this vault.
% A note adds its own definitions with a "preamble" property.
%
% \\newcommand{\\R}{\\mathbb{R}}
% \\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}
% \\DeclareMathOperator{\\tr}{tr}
`;

export const plugin = definePlugin({
  activate(ctx) {
    const reader = new ReaderImpl({
      ctx,
      vault: ctx.use(Vault),
      documents: ctx.use(Documents),
      syntax: ctx.use(MarkdownSyntax),
      index: ctx.use(MetadataIndex),
      workspace: ctx.use(Workspace),
    });
    ctx.register(
      reader.registerPostProcessor((root) => {
        for (const el of root.querySelectorAll<HTMLElement>('.callout')) decorateCallout(el);
      }),
    );
    ctx.provide(Reader, reader);

    // The LaTeX preamble: commands every formula of the vault can use.
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    const openPreamble = async () => {
      const path = reader.preamblePath();
      if (!vault.get(path)) await vault.create(path, PREAMBLE_TEMPLATE);
      await workspace.openFile(path);
    };
    ctx.commands.register({
      id: 'reader.open-preamble',
      title: 'Open LaTeX preamble',
      category: 'Math',
      run: openPreamble,
    });
    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'media',
          title: 'Media',
          group: 'plugins',
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Media'),
              settingItem(
                'Loop videos',
                'A video starts again when it ends, in notes, enlarged and in its own tab. Applies to videos shown from now on.',
                toggle(
                  ctx.settings.get('loopVideos', true),
                  (on) => void ctx.settings.set('loopVideos', on),
                  { label: 'Loop videos' },
                ),
              ),
            );
          },
        }),
      );
      ctx.register(
        settingsUi.registerTab({
          id: 'math',
          title: 'Math',
          group: 'plugins',
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Math'),
              settingItem(
                'LaTeX preamble',
                h(
                  'span',
                  {},
                  'A file with definitions every formula in this vault can use, such as \\newcommand{\\R}{\\mathbb{R}} or \\DeclareMathOperator{\\tr}{tr}. A .tex file is read as it is; of a note, the latex code blocks are read.',
                  h('br'),
                  'A note adds its own with a “preamble” property: TeX written there, or the name of another preamble file.',
                ),
                h(
                  'span',
                  { class: 'pm-setting-controls' },
                  textInput(
                    ctx.settings.get('preamble', DEFAULT_PREAMBLE),
                    (v) => {
                      void ctx.settings
                        .set('preamble', v.trim() || DEFAULT_PREAMBLE)
                        .then(() => reader.refreshMath());
                    },
                    { placeholder: DEFAULT_PREAMBLE },
                  ),
                  button('Open', () => void openPreamble()),
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
