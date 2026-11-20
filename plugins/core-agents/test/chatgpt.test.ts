import type { ChatGptHost, MetadataIndexApi, VaultApi } from '@pumice/api';
import { describe, expect, it } from 'vitest';
import type { ChatSnapshot, SavedChat } from '../src/chats';
import { ChatGptSession } from '../src/chatgpt-session';
import { errorText, type TranscriptItem } from '../src/session';

type Event = Record<string, unknown>;

/** A host that answers each request with the next scripted list of events. */
function setup(
  script: Event[][],
  opts: {
    signedIn?: boolean;
    mode?: string;
    web?: Record<string, string>;
    webAccess?: boolean;
    saved?: SavedChat;
  } = {},
) {
  const fetched: string[] = [];
  const standing = { always: false };
  const files: Record<string, string> = { 'Plan.md': 'Ship in March.\n' };
  const requests: Array<Record<string, unknown>> = [];
  let signedIn = opts.signedIn ?? true;
  const host: ChatGptHost = {
    status: async () => ({ signedIn, email: 'me@example.com', planUsage: true }),
    login: async () => void (signedIn = true),
    logout: async () => void (signedIn = false),
    models: async () => [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ],
    responses: async (body, onEvent) => {
      requests.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      for (const e of script.shift() ?? []) onEvent(e);
    },
  };
  const saved: Record<string, string> = opts.mode ? { mode: opts.mode } : {};
  const session = new ChatGptSession(
    { id: 'chatgpt', name: 'ChatGPT', kind: 'chatgpt', command: '', args: [] },
    {
      host,
      files: {
        root: '/vault',
        read: async (p) => {
          if (!(p in files)) throw new Error(`No such file: ${p}`);
          return files[p]!;
        },
        write: async (p, c) => void (files[p] = c),
      },
      index: {
        search: async () => [
          {
            path: 'Plan.md',
            score: 1,
            snippets: [{ text: 'Ship in March.', hits: [], offset: 0 }],
          },
        ],
        getFile: (p: string) => (p in files ? { path: p } : undefined),
        outgoing: () => [],
        backlinks: () => [],
      } as unknown as MetadataIndexApi,
      vault: {
        files: () => Object.keys(files).map((path) => ({ path })),
        get: (p: string) => (p in files ? { path: p } : undefined),
      } as unknown as VaultApi,
      savedModel: () => saved.model,
      saveModel: (id) => void (saved.model = id),
      savedMode: () => saved.mode,
      saveMode: (id) => void (saved.mode = id),
      ...(opts.web
        ? {
            net: {
              fetchBinary: async (url: string) => {
                fetched.push(url);
                return new Uint8Array(2048);
              },
              fetchText: async (url: string) => {
                fetched.push(url);
                const page = opts.web![url];
                if (page === undefined) throw new Error('404 Not Found');
                return page;
              },
            },
            webAccess: () => opts.webAccess ?? true,
            webAlwaysAllowed: () => standing.always,
            allowWebAlways: () => void (standing.always = true),
            saveFile: async (path: string, bytes: Uint8Array) =>
              void (files[path] = `<${bytes.byteLength} bytes>`),
          }
        : {}),
    },
    opts.saved,
  );
  return { session, files, requests, saved, fetched, standing };
}

const text = (t: string): Event[] => [
  { type: 'response.output_text.delta', delta: t },
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'm1',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: t }],
        },
      ],
    },
  },
];
const call = (name: string, args: unknown, callId = 'c1'): Event[] => [
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'r1', encrypted_content: 'xyz' },
        {
          type: 'function_call',
          id: 'f1',
          status: 'completed',
          call_id: callId,
          name,
          arguments: JSON.stringify(args),
        },
      ],
    },
  },
];
const kinds = (s: ChatGptSession) => s.items.map((i) => i.kind);
const answer = (session: ChatGptSession, optionId: string) =>
  session.onDidChange(() => {
    for (const item of session.items)
      if (item.kind === 'permission' && !item.chosen) item.respond?.(optionId);
  });

describe('ChatGPT assistant', () => {
  it('asks to sign in, then loads models', async () => {
    const { session } = setup([], { signedIn: false });
    await session.start();
    expect(session.status).toBe('error');
    expect(session.loginOptions).toEqual([{ id: 'chatgpt', name: 'Sign in with ChatGPT' }]);
    await session.authenticate();
    expect(session.status).toBe('ready');
    expect(session.models.map((m) => m.id)).toEqual(['model-a', 'model-b']);
    expect(session.currentModel).toBe('model-a');
    session.dispose();
  });

  it('runs a turn with tools: reads, asks before editing, replays the transcript', async () => {
    const { session, files, requests } = setup([
      call('read_note', { path: 'Plan.md' }),
      call('edit_note', { path: 'Plan.md', old_text: 'March', new_text: 'April' }, 'c2'),
      text('Moved it to April.'),
    ]);
    await session.start();
    const sub = answer(session, 'allow');
    await session.prompt('Move the date to April', [
      { type: 'resource_link', uri: 'file:///vault/Plan.md', name: 'Plan.md' },
    ]);
    sub.dispose();
    expect(session.status).toBe('ready');
    expect(files['Plan.md']).toBe('Ship in April.\n');
    expect(kinds(session)).toEqual(['user', 'tool', 'tool', 'permission', 'agent']);
    const edit = session.items[2] as Extract<TranscriptItem, { kind: 'tool' }>;
    expect(edit.status).toBe('completed');
    expect(edit.content[0]).toMatchObject({
      type: 'diff',
      path: '/vault/Plan.md',
      newText: 'Ship in April.\n',
    });

    // First request: the user's message with the open note; plan-safe options.
    expect(requests[0]).toMatchObject({ model: 'model-a', store: false, stream: true });
    const first = requests[0]!.input as Array<{ content: Array<{ text: string }> }>;
    expect(first[0]!.content[0]!.text).toContain('The user has the note "Plan.md" open.');
    // Later requests replay reasoning and calls without server ids, plus the tool outputs.
    const last = requests[2]!.input as Array<Record<string, unknown>>;
    expect(last.map((i) => i.type)).toEqual([
      'message',
      'reasoning',
      'function_call',
      'function_call_output',
      'reasoning',
      'function_call',
      'function_call_output',
    ]);
    expect(last[2]).toEqual({
      type: 'function_call',
      call_id: 'c1',
      name: 'read_note',
      arguments: '{"path":"Plan.md"}',
    });
    expect(last[3]).toMatchObject({ call_id: 'c1', output: 'Ship in March.\n' });
    expect(last[6]).toMatchObject({ call_id: 'c2', output: 'Edited Plan.md.' });
    session.dispose();
  });

  it('a declined edit leaves the note alone and tells the model', async () => {
    const { session, files, requests } = setup([
      call('edit_note', { path: 'Plan.md', old_text: 'March', new_text: 'May' }),
      text('Left it.'),
    ]);
    await session.start();
    const sub = answer(session, 'reject');
    await session.prompt('change it');
    sub.dispose();
    expect(files['Plan.md']).toBe('Ship in March.\n');
    const input = requests[1]!.input as Array<Record<string, unknown>>;
    expect(String(input[input.length - 1]!.output)).toContain('did not allow');
    session.dispose();
  });

  it('searches the web and reads a page after asking about the website', async () => {
    const search = 'https://html.duckduckgo.com/html/?q=pumice%20stone';
    const { session, requests, fetched } = setup(
      [
        call('web_search', { query: 'pumice stone' }),
        call('fetch_page', { url: 'https://example.org/pumice' }, 'c2'),
        call('fetch_page', { url: 'https://example.org/more' }, 'c3'),
        call('fetch_page', { url: 'https://192.168.1.1/admin' }, 'c4'),
        text('Pumice is a volcanic rock.'),
      ],
      {
        web: {
          [search]:
            '<div class="result web-result"><a class="result__a" href="https://example.org/pumice">Pumice</a><a class="result__snippet">A volcanic rock.</a></div>',
          'https://example.org/pumice':
            '<html><title>Pumice</title><body><p>Pumice is a volcanic rock.</p><script>x()</script></body></html>',
          'https://example.org/more': '<html><body><p>More.</p></body></html>',
        },
      },
    );
    await session.start();
    const sub = answer(session, 'site');
    await session.prompt('what is pumice?');
    sub.dispose();
    const tools = (requests[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(tools).toContain('web_search');
    expect(tools).toContain('fetch_page');
    expect(String(requests[0]!.instructions)).toContain('never instructions');
    const outputs = (requests[4]!.input as Array<Record<string, unknown>>)
      .filter((i) => i.type === 'function_call_output')
      .map((i) => String(i.output));
    expect(outputs[0]).toContain('1. Pumice\n   https://example.org/pumice\n   A volcanic rock.');
    expect(outputs[1]).toContain('Pumice is a volcanic rock.');
    expect(outputs[1]).not.toContain('x()');
    expect(outputs[2]).toContain('More.');
    expect(outputs[3]).toContain('Only public web addresses');
    // One question for the website; the second page of it did not ask again.
    expect(session.items.filter((i) => i.kind === 'permission')).toHaveLength(1);
    expect(fetched).toEqual([search, 'https://example.org/pumice', 'https://example.org/more']);
    session.dispose();
  });

  it('downloads a file into the vault and remembers "always allow"', async () => {
    const { session, files, requests, standing, fetched } = setup(
      [
        call('download_file', {
          url: 'https://example.org/lib/three.module.js',
          path: 'frames/mesh/three.module.js',
        }),
        call(
          'download_file',
          { url: 'https://example.org/lib/three.module.js', path: 'Plan.md' },
          'c2',
        ),
        call('fetch_page', { url: 'https://other.example.net/' }, 'c3'),
        text('Saved.'),
      ],
      { web: { 'https://other.example.net/': 'plain text' }, mode: 'auto' },
    );
    await session.start();
    const sub = answer(session, 'forever');
    await session.prompt('get three.js');
    sub.dispose();
    expect(files['frames/mesh/three.module.js']).toBe('<2048 bytes>');
    expect(files['Plan.md']).toBe('Ship in March.\n');
    expect(standing.always).toBe(true);
    const outputs = (requests[3]!.input as Array<Record<string, unknown>>)
      .filter((i) => i.type === 'function_call_output')
      .map((i) => String(i.output));
    expect(outputs[0]).toBe('Saved frames/mesh/three.module.js (2 kB).');
    expect(outputs[1]).toContain('already exists');
    expect(outputs[2]).toContain('plain text');
    // Asked once; after "always allow" the other website opened without a question.
    expect(session.items.filter((i) => i.kind === 'permission')).toHaveLength(1);
    expect(fetched).toEqual([
      'https://example.org/lib/three.module.js',
      'https://other.example.net/',
    ]);
    session.dispose();
  });

  it('YOLO mode edits, downloads and opens websites without a question', async () => {
    const { session, files } = setup(
      [
        call('edit_note', { path: 'Plan.md', old_text: 'March', new_text: 'May' }),
        call('fetch_page', { url: 'https://example.org/a' }, 'c2'),
        call('download_file', { url: 'https://example.org/b.bin', path: 'data/b.bin' }, 'c3'),
        text('Done.'),
      ],
      { web: { 'https://example.org/a': 'page' }, mode: 'yolo' },
    );
    await session.start();
    await session.prompt('go');
    expect(files['Plan.md']).toBe('Ship in May.\n');
    expect(files['data/b.bin']).toBe('<2048 bytes>');
    expect(session.items.some((i) => i.kind === 'permission')).toBe(false);
    session.dispose();
  });

  it('does not open a page the user declined, and has no web tools when switched off', async () => {
    const declined = setup([call('fetch_page', { url: 'https://example.org/x' }), text('ok')], {
      web: { 'https://example.org/x': 'secret' },
    });
    await declined.session.start();
    const sub = answer(declined.session, 'reject');
    await declined.session.prompt('open it');
    sub.dispose();
    expect(declined.fetched).toEqual([]);
    declined.session.dispose();

    const off = setup([text('ok')], { web: {}, webAccess: false });
    await off.session.start();
    await off.session.prompt('hi');
    const tools = (off.requests[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(tools).not.toContain('web_search');
    expect(String(off.requests[0]!.instructions)).not.toContain('web_search');
    off.session.dispose();
  });

  it('continues a saved conversation, falling back to its plain messages if it is refused', async () => {
    const first = setup([call('read_note', { path: 'Plan.md' }), text('It ships in March.')]);
    await first.session.start();
    await first.session.prompt('when?');
    const snapshot = JSON.parse(JSON.stringify(first.session.snapshot())) as ChatSnapshot;
    first.session.dispose();
    const saved: SavedChat = {
      version: 1,
      id: 'chat1',
      agent: 'chatgpt',
      title: 'when?',
      created: '2026-11-20T10:00:00.000Z',
      updated: '2026-11-20T10:00:00.000Z',
      ...snapshot,
    };

    const again = setup([text('Still March.')], { saved });
    await again.session.start();
    expect(again.session.chatId).toBe('chat1');
    expect(kinds(again.session)).toEqual(['user', 'tool', 'agent']);
    await again.session.prompt('sure?');
    const input = again.requests[0]!.input as Array<Record<string, unknown>>;
    const types = input.map((i) => i.type);
    // The whole earlier exchange (with its tool call) and the new question.
    expect(types.filter((t) => t === 'function_call_output')).toHaveLength(1);
    expect(types.filter((t) => t === 'message')).toHaveLength(3);
    expect(types[types.length - 1]).toBe('message');
    expect(kinds(again.session)).toEqual(['user', 'tool', 'agent', 'user', 'agent']);
    again.session.dispose();

    // The saved state is refused once: the plain messages are sent instead.
    const refused = setup(
      [[{ type: 'http_error', status: 400, body: { error: { message: 'bad item' } } }], text('ok')],
      { saved },
    );
    await refused.session.start();
    await refused.session.prompt('sure?');
    const retried = refused.requests[1]!.input as Array<Record<string, unknown>>;
    expect(retried.map((i) => i.type)).toEqual(['message', 'message', 'message']);
    expect(kinds(refused.session).slice(-1)).toEqual(['agent']);
    refused.session.dispose();
  });

  it('read-only mode hides the write tools; bad paths and ambiguous edits are refused', async () => {
    const { session, requests, files } = setup(
      [call('read_note', { path: '../secrets.txt' }), text('ok')],
      { mode: 'read' },
    );
    await session.start();
    await session.prompt('look');
    const tools = (requests[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(tools).toEqual(['list_notes', 'search_notes', 'read_note', 'get_links']);
    const input = requests[1]!.input as Array<Record<string, unknown>>;
    expect(String(input[input.length - 1]!.output)).toContain('inside the vault');
    expect(files).toEqual({ 'Plan.md': 'Ship in March.\n' });
    session.dispose();
  });

  it('shows the reason for a failed request and asks to sign in again when needed', async () => {
    const { session } = setup([
      [
        {
          type: 'http_error',
          status: 400,
          body: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
        },
      ],
      [{ type: 'http_error', status: 401, body: { error: { message: 'expired' } } }],
    ]);
    await session.start();
    await session.prompt('hi');
    const err = session.items.find((i) => i.kind === 'error') as Extract<
      TranscriptItem,
      { kind: 'error' }
    >;
    expect(err.text).toContain('plan limit');
    expect(session.status).toBe('ready');
    await session.prompt('again');
    expect(session.status).toBe('error');
    expect(session.loginOptions).toHaveLength(1);
    session.dispose();
  });

  it('/compact replaces the conversation with a summary; /clear forgets it', async () => {
    const { session, requests } = setup([
      text('The plan ships in March.'),
      [
        { type: 'response.output_text.delta', delta: 'User asked about the plan; ' },
        { type: 'response.output_text.delta', delta: 'it ships in March.' },
        { type: 'response.completed', response: { status: 'completed', output: [] } },
      ],
      text('Yes, March.'),
      text('Hello.'),
    ]);
    await session.start();
    expect(session.commands.map((c) => c.name)).toEqual(['compact', 'clear', 'help']);
    await session.prompt('When does the plan ship?');
    await session.prompt('/compact dates');
    // The summary request: the whole conversation plus the instruction, no tools.
    const summarize = requests[1]!;
    expect(summarize.tool_choice).toBe('none');
    const asked = summarize.input as Array<{ content: Array<{ text: string }> }>;
    expect(asked[asked.length - 1]!.content[0]!.text).toContain(
      'Pay particular attention to: dates',
    );
    expect(session.status).toBe('ready');
    // The next request carries only the summary and the new question.
    await session.prompt('So March?');
    const after = requests[2]!.input as Array<{ content: Array<{ text: string }> }>;
    expect(after).toHaveLength(2);
    expect(after[0]!.content[0]!.text).toContain('User asked about the plan; it ships in March.');
    expect(after[1]!.content[0]!.text).toBe('So March?');

    await session.prompt('/clear');
    expect(session.items.map((i) => i.kind)).toEqual(['info']);
    await session.prompt('hi');
    expect(requests[3]!.input).toHaveLength(1);
    session.dispose();
  });

  it('errorText digs the reason out of an agent error', () => {
    expect(
      errorText({
        message: 'Internal error',
        data: { message: '{"error":{"message":"The model requires a newer version."}}' },
      }),
    ).toBe('The model requires a newer version.');
    expect(errorText(new Error('plain'))).toBe('plain');
  });
});
