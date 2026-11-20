import { startApp } from '@pumice/app';
import { createElectronPlatform } from '@pumice/platform-electron';

const host = window.pumiceHost;
const root = document.getElementById('root')!;
if (!host) {
  root.textContent = 'Pumice must run inside the desktop app.';
} else {
  // `window.close()` from page code would skip the close handshake that flushes pending saves.
  window.close = () => void host.closeWindow();
  const platform = await createElectronPlatform(host);
  await startApp({ platform, root });
}
