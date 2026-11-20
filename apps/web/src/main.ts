import { startApp } from '@pumice/app';
import { createMemoryPlatform } from '@pumice/platform-memory';
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

const os = /Mac|iPhone|iPad/.test(navigator.platform)
  ? 'macos'
  : /Win/.test(navigator.platform)
    ? 'windows'
    : 'linux';
const platform = createMemoryPlatform({
  files: loadFiles(),
  kind: 'web',
  os,
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

const kernel = await startApp({ platform, root: document.getElementById('root')! });
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
