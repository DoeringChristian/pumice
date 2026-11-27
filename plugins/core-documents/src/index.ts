import { definePlugin, Documents, PlatformService, Vault, type PluginModule } from '@pumice/api';
import manifestJson from '../manifest.json';
import { DocumentsImpl } from './documents';
import { markdownCodec } from './markdown-codec';

export { DocumentsImpl } from './documents';
export { markdownCodec } from './markdown-codec';
export { applyTextDiff, applyTextDiffAs, merge3 } from './merge';

export const manifest = manifestJson;

export const plugin = definePlugin({
  activate(ctx) {
    const documents = ctx.register(new DocumentsImpl(ctx.use(Vault)));
    ctx.register(documents.registerCodec(markdownCodec));
    ctx.register(ctx.use(PlatformService).lifecycle.onPause(() => void documents.flushAll()));
    ctx.provide(Documents, documents);
  },
});

export default { manifest, plugin } satisfies PluginModule;
