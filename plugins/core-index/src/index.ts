import {
  Documents,
  MarkdownSyntax,
  MetadataIndex,
  Vault,
  definePlugin,
  type PluginModule,
} from '@pumice/api';
import manifestJson from '../manifest.json';
import { MetadataIndexImpl } from './metadata-index';
import { inlineParser, workerParser } from './parser-host';

export { MetadataIndexImpl, noteName, INDEX_VERSION } from './metadata-index';
export { inlineParser } from './parser-host';
export { resolveTarget, nameKey } from './resolve';

export const manifest = manifestJson;

export const plugin = definePlugin({
  async activate(ctx) {
    const syntax = ctx.use(MarkdownSyntax);
    const inline = inlineParser((text) => syntax.extract(text));
    // Plugin syntax (functions) can't cross into a worker: parse on the main thread then.
    const parser = syntax.hasCustomSyntax ? inline : workerParser(inline);
    const index = new MetadataIndexImpl({
      vault: ctx.use(Vault),
      documents: ctx.use(Documents),
      parser,
      storage: ctx.storage,
    });
    ctx.register(index);
    await index.start();
    ctx.provide(MetadataIndex, index);
    ctx.commands.register({
      id: 'index.rebuild',
      title: 'Rebuild the metadata index',
      run: () => index.rebuild(),
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
