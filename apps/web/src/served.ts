/**
 * Vaults that open with their links (a served folder: `pumice-server <folder>` prints them):
 * `<server>/#open=<vault>&key=<key>`. No accounts: a browser gets a name of its own on a server
 * the first time.
 */
import type { PublicUser, VaultInfo } from '@pumice/collab-protocol';
import { button, h, textInput } from '@pumice/ui';
import { deleteWebVault } from '@pumice/platform-web';
import {
  account,
  forgetVault,
  openedVaults,
  rememberVault,
  setAccount,
  vaultHash,
  vaultKey,
  type OpenedVault,
} from './accounts';
import './start.css';

export interface VaultLink {
  server: string;
  vault: string;
  key: string;
}

/** The vault link in an address (or a hash of this page, on `server`). */
export function linkIn(text: string, server = location.origin): VaultLink | undefined {
  let hash = text;
  try {
    const url = new URL(text);
    server = url.origin;
    hash = url.hash;
  } catch {
    // (Only the part after #.)
  }
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const vault = params.get('open');
  const key = params.get('key');
  return vault && key && /^[\w-]+$/.test(vault) && /^[\w-]+$/.test(key)
    ? { server, vault, key }
    : undefined;
}

/** Opens a vault with its link: as the name this browser has on that server, or a new one. */
export async function openLink(link: VaultLink): Promise<OpenedVault> {
  const signedIn = account(link.server);
  const r = await fetch(`${link.server}/api/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signedIn ? { Authorization: `Bearer ${signedIn.token}` } : {}),
    },
    body: JSON.stringify({
      vault: link.vault,
      key: link.key,
      device: navigator.userAgent.slice(0, 80),
    }),
  });
  const body = (await r.json().catch(() => ({}))) as {
    token?: string;
    user?: PublicUser;
    vault?: VaultInfo;
    error?: string;
  };
  if (r.status === 401 && signedIn) {
    // (That name's session ended: a new one.)
    setAccount(link.server, undefined);
    return openLink(link);
  }
  if (!r.ok || !body.token || !body.user || !body.vault)
    throw new Error(body.error ?? `The server answered ${r.status}.`);
  setAccount(link.server, { token: body.token, user: body.user });
  rememberVault(link.server, body.vault);
  return openedVaults().find(
    (v) => vaultKey(v) === vaultKey({ server: link.server, id: body.vault!.id }),
  )!;
}

/**
 * The page of a server whose vaults open with their links, without one: the vaults opened here
 * before, and a place for a link.
 */
let pruned = false;
/**
 * Forgets the vaults their servers no longer have (made anew, or the server's data gone), so
 * that the list shows what opens. Servers out of reach are left as they are. Whether any went.
 */
async function pruneGone(): Promise<boolean> {
  if (pruned) return false;
  pruned = true;
  let gone = false;
  for (const server of new Set(openedVaults().map((v) => v.server))) {
    const signedIn = account(server);
    if (!signedIn) continue;
    const r = await fetch(`${server}/api/me`, {
      headers: { Authorization: `Bearer ${signedIn.token}` },
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
    if (!r?.ok) continue;
    const there = new Set(((await r.json()) as { vaults: VaultInfo[] }).vaults.map((v) => v.id));
    for (const v of openedVaults())
      if (v.server === server && !there.has(v.id)) {
        forgetVault(vaultKey(v));
        await deleteWebVault(vaultKey(v)).catch(() => undefined);
        gone = true;
      }
  }
  return gone;
}

export function showLinkPage(root: HTMLElement, error = ''): void {
  const here = openedVaults();
  const host = (server: string) => server.replace(/^https?:\/\//, '');
  const link = textInput('', () => undefined, {
    placeholder: `${location.origin}/#open=…&key=…`,
    label: 'Link',
  });
  const go = (v: OpenedVault) => {
    location.hash = vaultHash(vaultKey(v));
    location.reload();
  };
  const form = h(
    'form',
    { class: 'pm-start-form' },
    h('label', { class: 'pm-start-field' }, h('span', {}, 'A vault’s link'), link),
    button('Open', () => undefined, { kind: 'primary' }),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const found = linkIn(link.value.trim());
    if (!found) return showLinkPage(root, 'That is not a link to a vault.');
    openLink(found).then(go, (err: unknown) =>
      showLinkPage(root, err instanceof Error ? err.message : String(err)),
    );
  });
  void pruneGone().then((gone) => gone && showLinkPage(root, error));
  root.className = 'pm-start';
  root.replaceChildren(
    h(
      'main',
      { class: 'pm-start-card' },
      h('h1', {}, 'Pumice'),
      error ? h('p', { class: 'pm-start-error', role: 'alert' }, error) : null,
      here.length
        ? h(
            'div',
            {},
            h('h2', {}, 'Opened here'),
            ...here.map((v) =>
              h(
                'p',
                {},
                h(
                  'a',
                  {
                    href: vaultHash(vaultKey(v)),
                    onclick: () => setTimeout(() => location.reload()),
                  },
                  v.name,
                ),
                v.server === location.origin ? null : ` · ${host(v.server)}`,
              ),
            ),
          )
        : null,
      h('p', {}, 'A shared vault opens with its link (its server prints them when it starts).'),
      form,
      h(
        'p',
        { class: 'pm-start-foot' },
        h(
          'a',
          { href: '#demo', onclick: () => setTimeout(() => location.reload()) },
          'Try the demo',
        ),
      ),
    ),
  );
}
