// A minimal ACP agent that takes MCP servers over ACP and uses Pumice's note tools: it lists
// them, reads note.md and edits it, and says what it saw.
import { Readable, Writable } from 'node:stream';
import {
  agent,
  ndJsonStream,
  McpOverAcpCaller,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk/unstable';

const caller = new McpOverAcpCaller({ clientInfo: { name: 'mock', version: '1' } });
let servers = [];
const app = agent({ name: 'mock-mcp' })
  .onNotification('mcp/message', caller.handleNotification)
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, mcpCapabilities: { acp: true } },
    authMethods: [],
  }))
  .onRequest('session/new', ({ params }) => {
    servers = params.mcpServers ?? [];
    return { sessionId: 's1' };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const say = (text) =>
      client.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const pumice = servers.find((s) => s.type === 'acp' && s.name === 'pumice');
    if (!pumice) {
      await say('NO TOOLS');
      return { stopReason: 'end_turn' };
    }
    const call = async (method, p) => {
      const outcome = await caller.request(client, pumice.serverId, method, p);
      if ('error' in outcome) throw new Error(JSON.stringify(outcome.error));
      return outcome.result;
    };
    await call('server/discover', {});
    const tools = (await call('tools/list', {})).tools.map((t) => t.name).sort();
    const read = await call('tools/call', { name: 'read_note', arguments: { path: 'note.md' } });
    const edit = await call('tools/call', {
      name: 'edit_note',
      arguments: { path: 'note.md', old_text: 'Hello', new_text: 'Hello, tools' },
    });
    // Where they are offered: search, and a drawing.
    const searched = tools.includes('search_notes')
      ? (await call('tools/call', { name: 'search_notes', arguments: { query: 'Hello' } }))
          .content[0].text
      : undefined;
    const drew = tools.includes('edit_drawing')
      ? (
          await call('tools/call', {
            name: 'edit_drawing',
            arguments: {
              path: 'sketch.excalidraw',
              operations: [{ op: 'add', id: 'box', type: 'rectangle', x: 0, y: 0, text: 'Hi' }],
            },
          })
        ).isError !== true
      : undefined;
    const outside = await call('tools/call', {
      name: 'read_note',
      arguments: { path: '../secret.md' },
    });
    await say(
      JSON.stringify({
        tools,
        read: read.content[0].text,
        edit: edit.content[0].text,
        outside: !!outside.isError,
        briefed: text.includes('"pumice" MCP server'),
        guided: text.includes('GUIDANCE-MARK'),
        ...(searched !== undefined ? { searched } : {}),
        ...(drew !== undefined ? { drew } : {}),
      }),
    );
    return { stopReason: 'end_turn' };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
