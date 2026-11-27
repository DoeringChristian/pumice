import { startApp } from '@pumice/app';
import { createWebPlatform, withServedFolder } from '@pumice/platform-web';
import type { SharedVaultSession } from '@pumice/platform';
import { account, vaultKey, type OpenedVault } from './accounts';
import { vaultSwitcher } from './switcher';

/** Opens a shared vault on its copy in this browser, kept in step by the collaboration plugin. */
export async function startVault(root: HTMLElement, vault: OpenedVault): Promise<void> {
  const key = vaultKey(vault);
  const signedIn = account(vault.server);
  if (!signedIn) throw new Error('Open this vault with its link.');
  const shared: SharedVaultSession = {
    server: vault.server,
    vaultId: vault.id,
    vaultName: vault.name,
    role: vault.role,
    token: signedIn.token,
    user: signedIn.user,
  };
  const platform = await createWebPlatform({
    id: key,
    name: vault.name,
    vaults: vaultSwitcher(key),
    // (A served folder's agents run on its server: where the folder is there.)
    shared: await withServedFolder(shared),
  });
  root.replaceChildren();
  root.className = '';
  await startApp({ platform, root });
}
