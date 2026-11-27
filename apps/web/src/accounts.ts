/** What this browser remembers: accounts by server, and the vaults opened here. */
import type { PublicUser, Role, VaultInfo } from '@pumice/collab-protocol';

export interface Account {
  token: string;
  user: PublicUser;
}

export interface OpenedVault {
  server: string;
  id: string;
  name: string;
  role: Role;
  lastOpened: number;
}

const ACCOUNTS = 'pumice-accounts';
const VAULTS = 'pumice-vaults';
const SERVER = 'pumice-server';

function read<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

/**
 * The address of a server as it is kept, or why it cannot be one. `securePage`: the app came
 * over https, and browsers let such a page talk to https servers only (or to this computer).
 */
export function serverAddress(
  input: string,
  securePage: boolean,
): { server: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: 'Enter the address of your Pumice server.' };
  const local = /^(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(text);
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `${local ? 'http' : 'https'}://${text}`);
  } catch {
    return { error: 'That is not an address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { error: 'The address starts with https://.' };
  const here = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (securePage && url.protocol === 'http:' && !here)
    return { error: 'Browsers only allow servers with https:// here.' };
  return { server: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** The name of a vault's database: the same vault id on two servers are two vaults. */
export const vaultKey = (v: { server: string; id: string }) => `${v.server}|${v.id}`;

/** The address within the page that shows a vault; a reload shows it again. */
export const vaultHash = (key: string) => `#vault=${encodeURIComponent(key)}`;

export const lastServer = () => read<string>(SERVER, '');
export const setLastServer = (server: string) => save(SERVER, server);

export const account = (server: string): Account | undefined =>
  read<Record<string, Account>>(ACCOUNTS, {})[server];
export function setAccount(server: string, value: Account | undefined): void {
  const { [server]: _old, ...others } = read<Record<string, Account>>(ACCOUNTS, {});
  save(ACCOUNTS, value ? { ...others, [server]: value } : others);
}

export const openedVaults = (): OpenedVault[] =>
  read<OpenedVault[]>(VAULTS, []).sort((a, b) => b.lastOpened - a.lastOpened);
export function rememberVault(server: string, info: VaultInfo): void {
  const entry = { server, id: info.id, name: info.name, role: info.role, lastOpened: Date.now() };
  const others = openedVaults().filter((v) => vaultKey(v) !== vaultKey(entry));
  save(VAULTS, [entry, ...others]);
}
export function forgetVault(key: string): void {
  save(
    VAULTS,
    openedVaults().filter((v) => vaultKey(v) !== key),
  );
}

/**
 * The Pumice server the page came from (rather than GitHub Pages or a folder), if any; `open`:
 * its vaults open with their links (served folders), there are no accounts.
 */
export async function servingServer(): Promise<{ open?: boolean } | undefined> {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return undefined;
  try {
    const r = await fetch(`${location.origin}/api/info`, { signal: AbortSignal.timeout(1500) });
    const info = r.ok ? ((await r.json()) as { pumice?: boolean; open?: boolean }) : {};
    return info.pumice === true ? info : undefined;
  } catch {
    return undefined;
  }
}
