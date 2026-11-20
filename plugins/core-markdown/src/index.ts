import {
  Emitter,
  MarkdownSyntax,
  definePlugin,
  type MarkdownSyntaxApi,
  type MarkdownSyntaxExtension,
  type PluginModule,
} from '@pumice/api';
import { dialectExtensions, metadataFromTree, parseMarkdown, renderHtml } from '@pumice/markdown';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

export class MarkdownSyntaxImpl implements MarkdownSyntaxApi {
  private readonly extensions: MarkdownSyntaxExtension[] = [];
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  register(extension: MarkdownSyntaxExtension) {
    if (!extension.lezer !== !(extension.micromark && extension.mdast)) {
      console.warn(
        `[core.markdown] syntax '${extension.name}' registers only one parser half; the editor and reading view will disagree.`,
      );
    }
    this.extensions.push(extension);
    this.changed.fire();
    return {
      dispose: () => {
        const i = this.extensions.indexOf(extension);
        if (i >= 0) this.extensions.splice(i, 1);
        this.changed.fire();
      },
    };
  }

  get hasCustomSyntax(): boolean {
    return this.extensions.some((e) => e.micromark || e.mdast || e.transform);
  }

  lezerExtensions() {
    return [
      ...dialectExtensions,
      ...this.extensions.flatMap((e) => (e.lezer ? [e.lezer].flat() : [])),
    ];
  }

  parse(text: string) {
    return parseMarkdown(text, {
      micromark: this.extensions.flatMap((e) => (e.micromark ? [e.micromark] : [])),
      mdast: this.extensions.flatMap((e) => (e.mdast ? [e.mdast] : [])),
      transforms: this.extensions.flatMap((e) => (e.transform ? [e.transform] : [])),
    });
  }

  extract(text: string) {
    return metadataFromTree(this.parse(text), {}, text);
  }

  renderHtml: MarkdownSyntaxApi['renderHtml'] = (tree, opts) => renderHtml(tree, opts);
}

export const plugin = definePlugin({
  activate(ctx) {
    ctx.provide(MarkdownSyntax, new MarkdownSyntaxImpl());
  },
});

export default { manifest, plugin } satisfies PluginModule;
