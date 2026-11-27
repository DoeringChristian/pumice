import '@pumice/ui/theme.css';
import { openedVaults, servingServer, vaultHash, vaultKey } from './accounts';

const root = document.getElementById('root')!;
// A vault's link put into the address of this page (only what follows # changes): opened.
window.addEventListener('hashchange', () => {
  if (/^#(.*&)?open=/.test(location.hash)) location.reload();
});

if (!window.isSecureContext) {
  // Browsers keep much of what Pumice needs (one tab per vault, copying, checksums) for pages
  // on https:// or on this computer.
  root.className = 'pm-start';
  root.innerHTML = `<main class="pm-start-card"><h1>Pumice</h1>
<p>Browsers run Pumice only from an <b>https://</b> address or from this computer
(<code>localhost</code>). To reach a Pumice server on another machine:</p>
<ul>
<li><code>ssh -L 8787:localhost:8787 &lt;server&gt;</code>, then open the link with
<code>localhost:8787</code>;</li>
<li>or on the server, <code>tailscale serve 8787</code>: an https:// address on your tailnet;</li>
<li>or a web server with https in front of it (Caddy, nginx).</li>
</ul></main>`;
} else if (location.hash === '#demo') {
  // The app itself is loaded once there is something to open.
  const { startDemo } = await import('./demo');
  await startDemo(root);
} else {
  // A vault's link (`#open=<vault>&key=…`, a served folder's): opened, then shown.
  const { linkIn, openLink, showLinkPage } = await import('./served');
  const link = linkIn(location.hash);
  let failed = '';
  if (link) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const opened = await openLink(link);
      history.replaceState(null, '', vaultHash(vaultKey(opened)));
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
  }
  const chosen = location.hash === '#vaults';
  if (chosen) history.replaceState(null, '', location.pathname + location.search);
  if (!chosen && !/^#vault=/.test(location.hash) && !failed && (await servingServer())) {
    // From a server of which one vault was opened here before: that one.
    const here = openedVaults().filter((v) => v.server === location.origin);
    if (here.length === 1) history.replaceState(null, '', vaultHash(vaultKey(here[0]!)));
  }
  if (/^#vault=/.test(location.hash)) await showChosen(showLinkPage);
  else showLinkPage(root, failed);
}

/** The vault the address names; `otherwise` (the start page) when it can't be opened. */
async function showChosen(otherwise: (root: HTMLElement, error?: string) => void): Promise<void> {
  const wanted = /^#vault=(.+)$/.exec(location.hash)?.[1];
  const key = wanted ? decodeURIComponent(wanted) : undefined;
  const vault = openedVaults().find((v) => vaultKey(v) === key);
  if (!vault) otherwise(root);
  else
    await import('./vault')
      .then(({ startVault }) => startVault(root, vault))
      .catch((e: unknown) => otherwise(root, e instanceof Error ? e.message : String(e)));
}
