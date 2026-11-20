import { definePlugin, PlatformService, Vault, type PluginModule } from '@pumice/api';
import manifestJson from '../manifest.json';
import { VaultImpl } from './vault';

export { VaultImpl, isIgnored } from './vault';

export const manifest = manifestJson;

export const plugin = definePlugin({
  async activate(ctx) {
    const platform = ctx.use(PlatformService);
    const vault = ctx.register(new VaultImpl(platform));
    await vault.load();
    ctx.provide(Vault, vault);
    if (!platform.watcher) {
      ctx.register(platform.lifecycle.onResume(() => void vault.rescan()));
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
