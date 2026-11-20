import type { ChatGptHost, MetadataIndexApi, VaultApi } from '@pumice/api';
import { describe, expect, it } from 'vitest';
import { ChatGptSession } from '../src/chatgpt-session';
import { errorText, type TranscriptItem } from '../src/session';

type Event = Record<string, unknown>;

/** A host that answers each request with the next scripted list of events. */
function setup(script: Event[][], opts: { signedIn?: boolean; mode?: string } = {}) {
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
    },
  );
  return { session, files, requests, saved };
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
