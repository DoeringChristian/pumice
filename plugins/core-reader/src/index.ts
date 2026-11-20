import {
  Documents,
  MarkdownSyntax,
  MetadataIndex,
  Reader,
  Vault,
  Workspace,
  definePlugin,
  type PluginModule,
} from '@pumice/api';
import { calloutStyle, createIcon } from '@pumice/ui';
import 'katex/dist/katex.min.css';
import manifestJson from '../manifest.json';
import { ReaderImpl } from './reader';
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
  },
});

export default { manifest, plugin } satisfies PluginModule;
