import '@pumice/ui/theme.css';
import { openedVaults, vaultKey } from './accounts';
import { showStart } from './start';

const root = document.getElementById('root')!;

if (location.hash === '#demo') {
  // The app itself is loaded once there is something to open.
  const { startDemo } = await import('./demo');
  await startDemo(root);
} else {
  const wanted = /^#vault=(.+)$/.exec(location.hash)?.[1];
  const key = wanted ? decodeURIComponent(wanted) : undefined;
  const vault = openedVaults().find((v) => vaultKey(v) === key);
  if (!vault) showStart(root);
  else
    await import('./vault')
      .then(({ startVault }) => startVault(root, vault))
      .catch((e: unknown) => showStart(root, e instanceof Error ? e.message : String(e)));
}
