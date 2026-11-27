# 10 — Vaults and sharing

A vault is what Pumice opens, and a vault can be shared. Opening a shared vault is like opening
any other: it is in the list of vaults and opens from there. Its files are on its server; this
device only keeps what it needs to open it fast and to go on offline. Sharing is something done to
a vault, not a setting of a folder.

## Why

Sharing grew as a plugin beside vaults, and it shows:

- Three ways to choose a vault, each its own: the desktop's start screen, the switcher behind the
  vault name, the web app's start page.
- Opening a shared vault meant first opening some folder, then pointing it at a server in
  Settings → Collaboration ("Join anyway?" when the folder is not empty).
- The link was taken in three places that each behaved differently.

## The model

A vault in the list is one of:

| Kind   | What it is                                   | Its copy                                                                                               |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| local  | a folder on this computer (desktop, mobile)  | the folder itself                                                                                      |
| shared | a vault on a Pumice server, opened by a link | none of its own: a cache in the app's storage (desktop and web alike), kept in step by the sync engine |
| demo   | the sample vault (web)                       | in the browser                                                                                         |

A shared vault is known by its server and its id there. What opens it is its link
(`<server>/#open=<vault>&key=<key>`, see 05 and `pumice-server <folder>`); what this device keeps
after opening is a session on that server under a generated name. Both belong to the shell (the
desktop's config, the browser's storage), not to a plugin's storage.

- **No folder for a shared vault**: its files are where its server keeps them (for a served
  folder: that folder, where its agents run too). The window shows the cache, as the browser does:
  on the desktop it is the same storage as on the web (the window's IndexedDB), with the desktop's
  menus and windows around it. A folder copy for other programs ("keep a folder copy") can come
  later as an option.
- **The platform knows the open vault is shared**: `Platform.shared = { server, vaultId, token,
user }` for a shared vault. The collaboration plugin starts from that, by itself; nothing to set.
- **The list**: `VaultSwitcher.list()` gives shared vaults with their server; `add(link)` opens a
  shared vault by its link (and puts it in the list), replacing `openShared`.

## What it looks like

**Opening a shared vault**: click the vault name (top left), paste the link into the search field;
the first entry becomes "Open this shared vault (server)": Enter, and the window shows it. The
desktop's start screen and the web's start page have the same field. The first time, the cache
fills in the background; after that it opens at once and works offline.

**The list**: the same everywhere: local and shared vaults together, shared ones marked with
their server. Opening one switches to it, as now.

**In a shared vault**: the status bar shows `● pumice · 2 here`; clicking it shows who is here,
the vault's link (copy; to everyone in the vault, for now), and the connection. Edits, presence, change marks and history work as now.

**Removing a shared vault from the list** removes its cache here (edits not yet sent are lost:
it says so if there are any). The vault itself stays on its server.

**Sharing a local vault**: for now from the server's side (`pumice-server <folder>`). Sharing from
the app needs a server that takes new vaults, which comes with accounts or a server password (later).

## What goes

- Settings → Collaboration (signing in, choosing a server, joining into the open folder, invites).
  What stays of it is the status popover above.
- The prompt after "Open a shared vault…" in the switcher; the field in Settings.
- The web app's separate start logic: the start page is the same list with the link field.

## What stays

- The sync engine (core.collab's SharedVault), the server, served folders with one link, agents
  for served folders, change marks, presence, history.
- Folders already linked to a shared vault (from Settings → Collaboration) keep working as they
  do, a folder kept in step, until their link is removed; they are not moved.

## Steps

1. `Platform.shared` and `VaultSwitcher.add`, with shared vaults in `list()` (desktop config, web
   storage); the collaboration plugin starts from `Platform.shared`. The desktop opens a shared
   vault in a window on the web platform's storage.
2. The switcher takes a pasted link (desktop, web), the start screen and start page too; the old
   prompt and the Settings tab go; the status popover.
3. Removing a shared vault (and its cache).
4. Tests: opening by link on desktop and web (Playwright), offline and back, the list, removing.

## Decided

- Shared vaults have no folder on this device, only a cache in the app's storage.
- The link is shown to everyone in the vault (for now; a link without agents can come later).
