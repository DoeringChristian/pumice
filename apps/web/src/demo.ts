import { startApp } from '@pumice/app';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { browserOs } from '@pumice/platform-web';
import { sampleVault } from './sample-vault';

const STORAGE_KEY = 'pumice-demo-vault';

function loadFiles(): Record<string, string> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved) as Record<string, string>;
  } catch {
    // ignore: fall back to the sample vault
  }
  return sampleVault;
}

/** A sample vault in memory, to try Pumice (and to work on it) without a server. */
export async function startDemo(root: HTMLElement): Promise<void> {
  const platform = createMemoryPlatform({
    files: loadFiles(),
    kind: 'web',
    os: browserOs(),
    vaultName: 'Demo vault',
  });

  // The demo vault lives in memory; keep a copy in localStorage across reloads.
  let resetting = false;
  const persist = () => {
    if (resetting) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(platform.fs.snapshot()));
    } catch {
      // storage full or blocked: the demo keeps working in memory
    }
  };
  setInterval(persist, 2000);
  window.addEventListener('beforeunload', persist);

  const kernel = await startApp({ platform, root });
  Object.assign(window, {
    pumice: {
      kernel,
      platform,
      reset: () => {
        resetting = true;
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
      },
    },
  });
}
