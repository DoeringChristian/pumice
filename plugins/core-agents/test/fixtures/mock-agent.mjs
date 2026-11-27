// A minimal ACP agent for tests: reads a note, asks permission, edits it, reports progress.
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

let cwd = '';
// The model and the effort, as configuration options (models in groups, as ACP allows).
const chosen = { model: 'fast', effort: 'medium' };
const configOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: chosen.model,
    options: [
      { group: 'small', name: 'Small', options: [{ value: 'fast', name: 'Fast' }] },
      { group: 'large', name: 'Large', options: [{ value: 'deep', name: 'Deep' }] },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: chosen.effort,
    options: ['low', 'medium', 'high'].map((v) => ({ value: v, name: v })),
  },
];
const app = agent({ name: 'mock' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: !process.argv.includes('--no-load') },
    authMethods: [],
  }))
  .onRequest('session/new', ({ params }) => {
    cwd = params.cwd;
    return {
      sessionId: 's1',
      configOptions: configOptions(),
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    };
  })
  .onRequest('session/load', async ({ params, client }) => {
    if (params.sessionId !== 's1') throw new Error('unknown session');
    cwd = params.cwd;
    // Agents replay the conversation when one is loaded.
    await client.notify('session/update', {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } },
    });
    return { configOptions: configOptions() };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    if (!(params.configId in chosen)) throw new Error('no such option');
    chosen[params.configId] = params.value;
    return { configOptions: configOptions() };
  })
  .onRequest('session/set_mode', () => ({}))
  .onRequest('session/prompt', async ({ params, client }) => {
    const update = (u) => client.notify('session/update', { sessionId: 's1', update: u });
    const text = params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const resources = params.prompt.filter((b) => b.type === 'resource').length;
    await update({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: 'Summarize the conversation', input: { hint: 'focus' } },
        { name: 'review', description: 'Review changes' },
      ],
    });
    await update({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    });
    await update({
      sessionUpdate: 'plan',
      entries: [{ content: 'Edit the note', status: 'in_progress', priority: 'high' }],
    });
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Got "${text}" ` },
    });
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `with ${resources} resource(s).` },
    });
    const path = `${cwd}/note.md`;
    await update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit note.md',
      kind: 'edit',
      status: 'pending',
      locations: [{ path }],
    });
    const { content } = await client.request('fs/read_text_file', { sessionId: 's1', path });
    const answer = await client.request('session/request_permission', {
      sessionId: 's1',
      toolCall: { toolCallId: 't1', title: 'Edit note.md' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow') {
      const next = content + ' (edited by agent)';
      await client.request('fs/write_text_file', { sessionId: 's1', path, content: next });
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'diff', path, oldText: content, newText: next }],
      });
    } else {
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
    }
    // Outside the vault: the client must refuse.
    try {
      await client.request('fs/read_text_file', { sessionId: 's1', path: '/etc/hosts' });
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' LEAK' },
      });
    } catch {
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' (outside read refused)' },
      });
    }
    return { stopReason: 'end_turn' };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
