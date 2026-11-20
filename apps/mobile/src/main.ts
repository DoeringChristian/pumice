import { startApp } from '@pumice/app';
import { createCapacitorPlatform } from '@pumice/platform-capacitor';

const root = document.getElementById('root')!;
try {
  const platform = await createCapacitorPlatform();
  await startApp({ platform, root });
} catch (e) {
  root.className = 'pm-fatal';
  root.textContent = `Pumice could not start: ${e instanceof Error ? e.message : String(e)}`;
}
