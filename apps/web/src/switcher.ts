/** Going from one vault to another in this browser (one vault to a page: going starts over). */
import type { VaultSwitcher } from '@pumice/platform';
import { deleteWebVault } from '@pumice/platform-web';
import { forgetVault, openedVaults, vaultHash, vaultKey } from './accounts';

/** The demo vault's id among them. */
export const DEMO = 'demo';

function go(hash: string): void {
  location.hash = hash;
  location.reload();
}

/** The vaults opened in this browser and the demo; `current` is the one on this page. */
export function vaultSwitcher(current: string): VaultSwitcher {
  return {
    list: async () => [
      ...openedVaults().map((v) => ({
        id: vaultKey(v),
        name: v.name,
        location: v.server,
        current: vaultKey(v) === current,
        lastOpened: v.lastOpened,
      })),
      { id: DEMO, name: 'Demo vault', location: 'In this browser', current: current === DEMO },
    ],
    open: async (id) => go(id === DEMO ? '#demo' : vaultHash(id)),
    // (The page of vaults, even where one would open by itself.)
    pick: async () => (go('#vaults'), true),
    // (The page opens it, see main.ts: also when only what follows # changes.)
    add: async (link) => {
      location.href = link.trim();
    },
    forget: async (id) => {
      if (id === DEMO) return;
      await deleteWebVault(id);
      forgetVault(id);
    },
  };
}
