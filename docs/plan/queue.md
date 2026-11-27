# Queue

Features to add when there is time, newest ideas at the end of their section. Larger designs
link to where they are worked out.

## Now

- **Changes not typed here**: flash an assistant's, a program's or a collaborator's larger
  change in its author's colour, with the author's name; optionally keep them marked until kept
  or undone ("keep until reviewed"). The assistant edits under its own name (presence), in
  small steps rather than one replaced range.

## Hosting and sharing ([05](05-collaboration.md))

- **Browser vaults without a server**: create and open vaults kept only in the browser (the
  GitHub Pages app on its own), download a vault as a zip and import one.
- **The server serves the web app** (one program: hosted mode), finding its server by itself.
- **Access by link, no sign-in by default**: an edit link and a read link per vault; names and
  colours generated automatically (changeable); "reset link" to shut people out.
- **Accounts as an option** of the server; a setting for who may create vaults (anyone, or with
  an admin password or invite); limits per address and per vault.
- **Folder sync in the server** (`pumice-server --vault <folder>`): the server keeps a folder
  of files and a shared vault in step, so agents on a machine report by writing files. With an
  ignore list and a size limit for attachments.
- **File-less browser storage** for shared vaults: only the Yjs documents, the file interface
  read from them (no projected copy).
- **End-to-end encryption** as an option per vault (key in the link), compaction and history in
  the clients (D14).
- **Who deleted text**: Yjs records who inserted text, not who deleted it, so a deletion that
  arrives alone from another app is marked without a name and never kept for review. The sync
  messages could carry their author.
- **Agents as collaborators**: a CLI or MCP tool through which an agent joins a shared vault
  under its own name and edits the Yjs documents directly.
- **Owner-only server** (for a server on a public network that only its owner uses): no
  sign-up; the first device is set up with a one-time link printed by the server, more devices
  are added from a signed-in device (or another link from the server's console); agents get a
  token per agent and vault from the server's command line, which can be revoked; a list of
  devices and tokens to revoke. HTTPS through a proxy (Caddy) or a private network (Tailscale).
- **Sign-in codes can be guessed today**: asking for a new code resets the 5 attempts, and
  nothing limits requests per address, so a code can be guessed by asking again and again.
  Limit attempts per address and per email over time.
- **Sign-in without email**: one-time links instead of emailed codes (the first from the
  server's console, then from signed-in devices); who may join is a server setting (owner
  only, people with a vault's link, or accounts by invite), not a separate mode.
- Sending sign-in codes by email (SMTP): not wanted for now.
- Frames from the server (on a domain of their own), PDF export in the browser.

## Media

- **Lightbox: flick through pictures** with the left and right arrow keys (and swiping on
  touch screens): the pictures of the note, in order.

## Open questions

- Setext headings with `-`: which rule.
- A formula in a table's header row.
