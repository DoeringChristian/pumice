import type { SharedVaultSession } from '@pumice/platform';

/**
 * A shared vault that is a served folder (`pumice-server <folder>`): to its owners, where the
 * folder is on its server. Its agents run there, in chats the server keeps (docs/plan/11).
 */
export async function withServedFolder(shared: SharedVaultSession): Promise<SharedVaultSession> {
  if (shared.role !== 'owner') return shared;
  const r = await fetch(`${shared.server}/api/vaults/${shared.vaultId}/folder`, {
    headers: { Authorization: `Bearer ${shared.token}` },
  }).catch(() => undefined);
  if (!r?.ok) return shared;
  const { root } = (await r.json()) as { root: string };
  return { ...shared, folder: root };
}
