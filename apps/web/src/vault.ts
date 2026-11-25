import { startApp } from '@pumice/app';
import { createWebPlatform, deleteWebVault } from '@pumice/platform-web';
import type { VaultSwitcher } from '@pumice/platform';
import {
  account,
  forgetVault,
  openedVaults,
  vaultHash,
  vaultKey,
  type OpenedVault,
} from './accounts';

/** One vault to a page: going to another starts over. */
function go(hash: string): void {
  location.hash = hash;
  location.reload();
}

/** Opens a shared vault on its copy in this browser, kept in sync by the collaboration plugin. */
export async function startVault(root: HTMLElement, vault: OpenedVault): Promise<void> {
  const key = vaultKey(vault);
  const signedIn = account(vault.server);
  if (!signedIn) throw new Error('Sign in to open this vault.');
  const vaults: VaultSwitcher = {
    list: async () =>
      openedVaults().map((v) => ({
        id: vaultKey(v),
        name: v.name,
        location: v.server,
        current: vaultKey(v) === key,
        lastOpened: v.lastOpened,
      })),
    open: async (id) => go(vaultHash(id)),
    pick: async () => (go(''), true),
    forget: async (id) => {
      await deleteWebVault(id);
      forgetVault(id);
    },
  };
  const platform = await createWebPlatform({ id: key, name: vault.name, vaults });
  // Tells the collaboration plugin which shared vault this is, and as whom.
  await platform.storage.set(
    'plugin:core.collab:link',
    JSON.stringify({
      server: vault.server,
      token: signedIn.token,
      user: signedIn.user,
      vaultId: vault.id,
      vaultName: vault.name,
      role: vault.role,
    }),
  );
  root.replaceChildren();
  root.className = '';
  await startApp({ platform, root });
}
