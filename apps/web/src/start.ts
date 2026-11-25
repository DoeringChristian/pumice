/** The page before a vault is open: the server, signing in, and choosing a shared vault. */
import { CollabClient } from '@pumice/core-collab';
import type { VaultInfo } from '@pumice/collab-protocol';
import { deleteWebVault } from '@pumice/platform-web';
import { button, h, textInput } from '@pumice/ui';
import {
  account,
  forgetVault,
  lastServer,
  openedVaults,
  rememberVault,
  serverAddress,
  setAccount,
  setLastServer,
  vaultHash,
  vaultKey,
} from './accounts';
import './start.css';

export function showStart(root: HTMLElement, message = ''): void {
  let server = lastServer();
  /** Where the code went; set while one is waited for. */
  let sentTo: string | undefined;
  let devCode: string | undefined;
  let vaults: VaultInfo[] | undefined;
  let offline = false;
  let error = message;

  const open = (info: VaultInfo, on = server) => {
    rememberVault(on, info);
    location.hash = vaultHash(vaultKey({ server: on, id: info.id }));
    location.reload();
  };

  const run = async (task: () => Promise<void>) => {
    error = '';
    try {
      await task();
    } catch (e) {
      error =
        e instanceof TypeError
          ? `Could not reach ${server}. Check the address and that the server is running.`
          : e instanceof Error
            ? e.message
            : String(e);
    }
    render();
  };

  const loadVaults = async () => {
    const signedIn = account(server);
    if (!signedIn) return;
    try {
      vaults = (await new CollabClient(server, signedIn.token).me()).vaults;
      offline = false;
    } catch (e) {
      if (e instanceof Error && e.message === 'Not signed in') {
        setAccount(server, undefined);
        throw new Error('Your session has ended. Sign in again.');
      }
      // Not reachable: what was opened here before still opens.
      if (!(e instanceof TypeError)) throw e;
      offline = true;
    }
  };

  const field = (label: string, input: HTMLInputElement) =>
    h('label', { class: 'pm-start-field' }, h('span', {}, label), input);
  const form = (submit: () => Promise<void>, ...children: Node[]) => {
    const el = h('form', { class: 'pm-start-form' }, ...children);
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      void run(submit);
    });
    return el;
  };
  const submitButton = (text: string) => {
    const b = button(text, () => undefined, { kind: 'primary' });
    b.type = 'submit';
    return b;
  };
  const plainButton = (text: string, task: () => void) => {
    const b = button(text, task, { kind: 'plain' });
    b.type = 'button';
    return b;
  };

  const signIn = (): Node => {
    if (sentTo !== undefined) {
      const email = sentTo;
      const code = textInput('', () => undefined, { placeholder: '123456', label: 'Code' });
      code.inputMode = 'numeric';
      code.autocomplete = 'one-time-code';
      const name = textInput('', () => undefined, { label: 'Your name' });
      return form(
        async () => {
          const r = await new CollabClient(server, undefined).verify(
            email,
            code.value.trim(),
            name.value.trim() || undefined,
            navigator.userAgent.slice(0, 80),
          );
          setAccount(server, { token: r.token, user: r.user });
          sentTo = undefined;
          devCode = undefined;
          await loadVaults();
        },
        h(
          'p',
          {},
          devCode ? `Development server: your code is ${devCode}.` : `A code was sent to ${email}.`,
        ),
        field('Code', code),
        field('Your name (new accounts)', name),
        submitButton('Sign in'),
        plainButton('Back', () => {
          sentTo = undefined;
          render();
        }),
      );
    }
    const address = textInput(server, () => undefined, {
      placeholder: 'https://notes.example.com',
      label: 'Server',
    });
    const email = textInput('', () => undefined, {
      placeholder: 'you@example.com',
      label: 'Email',
    });
    email.type = 'email';
    email.autocomplete = 'email';
    return form(
      async () => {
        const checked = serverAddress(address.value, location.protocol === 'https:');
        if ('error' in checked) throw new Error(checked.error);
        server = checked.server;
        setLastServer(server);
        if (account(server)) return loadVaults();
        if (!email.value.trim()) throw new Error('Enter your email address.');
        const r = await new CollabClient(server, undefined).requestCode(email.value.trim());
        sentTo = email.value.trim();
        devCode = r.code;
      },
      field('Pumice server', address),
      field('Email', email),
      submitButton('Send code'),
    );
  };

  const vaultRow = (info: VaultInfo, here: boolean) => {
    const key = vaultKey({ server, id: info.id });
    return h(
      'div',
      { class: 'pm-start-vault' },
      h(
        'button',
        { class: 'pm-start-open', type: 'button', onclick: () => open(info) },
        h('strong', {}, info.name),
        h('span', {}, here ? `${info.role} · on this browser` : info.role),
      ),
      here
        ? plainButton('Remove copy', () => {
            // Edits that did not reach the server yet exist only here.
            if (
              !window.confirm(
                `Remove this browser’s copy of “${info.name}”? Changes not yet sent to the server are lost. The shared vault itself stays.`,
              )
            )
              return;
            void run(async () => {
              await deleteWebVault(key);
              forgetVault(key);
            });
          })
        : null,
    );
  };

  const chooser = (): Node => {
    const signedIn = account(server)!;
    const opened = openedVaults().filter((v) => v.server === server);
    const here = new Set(opened.map((v) => v.id));
    const listed: VaultInfo[] | undefined = offline
      ? opened.map((v) => ({ id: v.id, name: v.name, role: v.role, createdAt: 0 }))
      : vaults;
    const invite = textInput('', () => undefined, { placeholder: 'Invite link', label: 'Invite' });
    const name = textInput('', () => undefined, { placeholder: 'Name', label: 'New vault' });
    const client = () => new CollabClient(server, signedIn.token);
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'pm-start-account' },
        h('span', {}, `${signedIn.user.name} on ${server.replace(/^https?:\/\//, '')}`),
        plainButton('Sign out', () => {
          void run(async () => {
            // The session ends on the server too, if it can be reached.
            await fetch(`${server}/api/auth/logout`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${signedIn.token}` },
            }).catch(() => undefined);
            setAccount(server, undefined);
            vaults = undefined;
          });
        }),
      ),
      offline
        ? h('p', {}, 'The server cannot be reached. Vaults opened here before still open.')
        : null,
      h('h2', {}, 'Your vaults'),
      !listed
        ? h('p', {}, 'Loading…')
        : listed.length
          ? h('div', {}, ...listed.map((v) => vaultRow(v, here.has(v.id))))
          : h('p', {}, 'None yet.'),
      offline
        ? null
        : h(
            'div',
            {},
            h('h2', {}, 'Join or create'),
            form(
              async () => {
                const token = invite.value.trim().replace(/\/+$/, '').split('/').pop() ?? '';
                if (!token) throw new Error('Paste the invite link someone sent you.');
                open(await client().acceptInvite(token));
              },
              h('div', { class: 'pm-start-row' }, invite, submitButton('Join')),
            ),
            form(
              async () => {
                if (!name.value.trim()) throw new Error('Give the vault a name.');
                open(await client().createVault(name.value.trim()));
              },
              h('div', { class: 'pm-start-row' }, name, submitButton('Create')),
            ),
          ),
    );
  };

  const render = () => {
    root.className = 'pm-start';
    root.replaceChildren(
      h(
        'main',
        { class: 'pm-start-card' },
        h('h1', {}, 'Pumice'),
        error ? h('p', { class: 'pm-start-error', role: 'alert' }, error) : null,
        server && account(server) ? chooser() : signIn(),
        h(
          'p',
          { class: 'pm-start-foot' },
          'Notes are kept in this browser and on your server. ',
          h(
            'a',
            {
              href: '#demo',
              onclick: () => setTimeout(() => location.reload()),
            },
            'Try the demo',
          ),
        ),
      ),
    );
  };
  render();
  // (Not cleared by this: why the vault that was asked for did not open.)
  if (account(server))
    void run(async () => {
      await loadVaults();
      error = message;
    });
}
