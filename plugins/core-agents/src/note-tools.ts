import { fromJsonSchema, McpServer, type jsonSchemaValidator } from '@modelcontextprotocol/server';
import { fromMcpServer } from '@agentclientprotocol/sdk/experimental/mcp-server';
import { vaultGuide, vaultTools, type VaultToolContext } from './vault-tools';

/**
 * The vault's tools (vault-tools.ts) for the agent programs, as the "pumice" MCP server over their
 * ACP connection (MCP-over-ACP): reading, searching and changing notes and drawings through the
 * vault, so a change shows at once in every window, under the agent's name, merged with what
 * people type. The agent keeps its own tools for everything else.
 */

export const NOTE_TOOLS = 'pumice';

/** What the agent is told about them, with the first message. */
export function toolsGuidance(ctx: VaultToolContext): string {
  return `This folder is a Pumice vault: its notes (Markdown) are open in the Pumice app, where people may be editing them while you work.
For notes and drawings, use the tools of the "${NOTE_TOOLS}" MCP server (read_note, search_notes, list_notes, get_links, edit_note, create_note${ctx.drawings ? ', read_drawing, edit_drawing' : ''}). They go through Pumice: your changes show at once in the app, under your name, and are merged with what people type meanwhile. Writing a note with your own file tools or the shell works too, but then it reaches Pumice as a change made elsewhere, not as yours, and can undo what someone typed since you read it.
For everything else (running programs, scripts, data, other files) use your own tools as usual; to report results, write them into a note. Pictures, PDFs and other files you make or download: save them in the vault with your own tools, then show them in a note with ![[path/to/file.png]] (relative to the vault).
Paths are relative to the vault folder.

${vaultGuide(ctx)}`;
}

/**
 * Arguments are checked by the tools themselves (as for the built-in assistant): the schemas are
 * what the agent is told, not compiled into checks (which would need code made at run time).
 */
const ANY_OBJECT: jsonSchemaValidator = {
  getValidator: () => (input: unknown) =>
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? { valid: true, data: input as never, errorMessage: undefined }
      : { valid: false, data: undefined, errorMessage: 'The arguments are not an object.' },
};

/** The tools, on a chat's view of the vault (its file access: see ledger.ts). */
export function noteTools(context: () => VaultToolContext) {
  return fromMcpServer(() => {
    const server = new McpServer({ name: NOTE_TOOLS, version: '1.0.0' });
    const ctx = context();
    for (const tool of vaultTools(ctx))
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: fromJsonSchema<Record<string, unknown>>(
            tool.parameters as never,
            ANY_OBJECT,
          ),
        },
        async (args: Record<string, unknown>) => {
          try {
            // (The agent asks the user about its tools itself, as about its own.)
            const result = await tool.run(args, ctx, { beforeWrite: async () => undefined });
            return {
              content: [
                { type: 'text' as const, text: result.text },
                ...(result.picture
                  ? [
                      {
                        type: 'image' as const,
                        mimeType: 'image/png',
                        data: result.picture.url.slice(result.picture.url.indexOf(',') + 1),
                      },
                    ]
                  : []),
              ],
            };
          } catch (e) {
            return {
              content: [
                { type: 'text' as const, text: e instanceof Error ? e.message : String(e) },
              ],
              isError: true,
            };
          }
        },
      );
    return server;
  });
}
