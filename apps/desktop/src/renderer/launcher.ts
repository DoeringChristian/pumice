// The vault selector: the window shown when no vault is open (first start, or "Manage vaults").
import type { LauncherHost, LauncherVault } from '@pumice/platform-electron/host';

const host = (window as unknown as { pumiceLauncher?: LauncherHost }).pumiceLauncher!;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $('vaults');
const menu = $('menu');
const actions = $('actions');
const form = $<HTMLFormElement>('create');
const nameInput = $<HTMLInputElement>('name');
const locationLabel = $('location');
const error = $('error');
let parentDir = '';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const fail = (e: unknown) => {
  error.textContent =
    e instanceof Error
      ? e.message.replace(/^Error invoking remote method [^:]+: (Error: )?/, '')
      : String(e);
};

function showMenu(vault: LauncherVault, anchor: HTMLElement): void {
  menu.replaceChildren();
  const item = (label: string, run: () => Promise<unknown>) => {
    const b = el('button', '', label);
    b.setAttribute('role', 'menuitem');
    b.onclick = () => {
      menu.hidden = true;
      void run().then(render, fail);
    };
    menu.append(b);
  };
  if (!vault.missing)
    item(host.platform === 'darwin' ? 'Reveal in Finder' : 'Show in file manager', () =>
      host.reveal(vault.path),
    );
  item('Remove from list', () => host.forget(vault.path));
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 200)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.hidden = false;
}

/** The path, cut off at the start when too long (the end is the part that tells vaults apart). */
function pathLabel(v: LauncherVault): HTMLElement {
  const div = el('div', 'vault-path');
  // `bdi` keeps the path's own punctuation in order inside the right-to-left box.
  const bdi = document.createElement('bdi');
  bdi.textContent = v.missing ? `${v.path} — not found` : v.path;
  div.append(bdi);
  return div;
}

async function render(): Promise<void> {
  const vaults = await host.list();
  list.replaceChildren();
  if (!vaults.length) {
    list.append(el('div', 'empty', 'No vaults yet. Create one, or open a folder.'));
    return;
  }
  for (const v of vaults) {
    const row = el('div', `vault${v.missing ? ' is-missing' : ''}`);
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    row.title = v.missing ? `${v.path} (not found)` : v.path;
    const text = el('div', 'vault-text');
    text.append(el('div', 'vault-name', v.name), pathLabel(v));
    const more = el('button', 'vault-more', '⋯');
    more.title = 'More options';
    more.setAttribute('aria-label', `More options for ${v.name}`);
    more.onclick = (e) => {
      e.stopPropagation();
      showMenu(v, more);
    };
    row.append(text, more);
    const open = () => {
      if (v.missing) return showMenu(v, more);
      void host.open(v.path).catch(fail);
    };
    row.onclick = open;
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') open();
    };
    list.append(row);
  }
}

document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) menu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!menu.hidden) menu.hidden = true;
    else if (!form.hidden) showCreate(false);
  }
});

function showCreate(show: boolean): void {
  form.hidden = !show;
  actions.hidden = show;
  error.textContent = '';
  if (show) nameInput.focus();
}

$('open-folder').onclick = () => void host.pick().catch(fail);
$('show-create').onclick = () => showCreate(true);
$('back').onclick = () => showCreate(false);
$('browse').onclick = async () => {
  const dir = await host.chooseFolder();
  if (dir) {
    parentDir = dir;
    locationLabel.textContent = dir;
  }
};
form.onsubmit = (e) => {
  e.preventDefault();
  error.textContent = '';
  const name = nameInput.value.trim();
  if (!name) return fail(new Error('Give the vault a name.'));
  void host.create(name, parentDir).catch(fail);
};

void (async () => {
  const info = await host.info();
  $('version').textContent = `Version ${info.version}`;
  parentDir = info.defaultLocation;
  locationLabel.textContent = parentDir;
  await render();
})();
window.addEventListener('focus', () => void render());
