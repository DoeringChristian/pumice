import {
  AuthoredChange,
  markdownText,
  type AuthorPresence,
  type ChangeAuthor,
  type DocumentsApi,
  type VaultApi,
  type VaultPath,
} from '@pumice/api';
import { applyTextDiff, applyTextDiffAs } from '@pumice/core-documents';
import { mergedWrite } from './ledger';
import type { AgentFiles } from './session';

/**
 * Writing notes for assistants, the same in a window and on a server: through the note's
 * document, so the change merges live with the editor and with collaborators, in small steps
 * (only what changed), under the assistant's own name and Yjs client.
 */
export function noteWriter(documents: DocumentsApi, vault: VaultApi) {
  /** The Yjs client each assistant edits as: its changes are its own in the document. */
  const clients = new Map<string, number>();
  const clientOf = (name: string) => {
    let id = clients.get(name);
    if (id === undefined) {
      id = crypto.getRandomValues(new Uint32Array(1))[0]!;
      clients.set(name, id);
    }
    return id;
  };

  /**
   * Writes `content` to `path` under `author` (none: what the user asked for, like taking a
   * change back). With `base` (what the writer read), merged with what changed since.
   */
  const write = async (
    path: VaultPath,
    content: string,
    author?: ChangeAuthor,
    base?: string,
  ): Promise<string> => {
    if (!vault.get(path) || !/\.(md|markdown|txt)$/i.test(path)) {
      // (Not merged: a file that changed since is not overwritten.)
      if (base !== undefined && vault.get(path))
        mergedWrite(path, await vault.read(path), content, base);
      await vault.write(path, content);
      return content;
    }
    const handle = await documents.open(path);
    try {
      const doc = handle.doc;
      const ytext = markdownText(doc);
      // Merged with what changed since the writer read it, as the note is at this moment.
      content = mergedWrite(path, ytext.toString(), content, base);
      if (ytext.toString() === content) return content;
      if (!author) {
        doc.transact(() => applyTextDiff(ytext, content), 'agent-undo');
        return content;
      }
      const client = clientOf(author.name);
      // In a shared vault the others learn whose that client is.
      const presence = handle.awareness as
        | {
            getLocalState(): AuthorPresence | null;
            setLocalStateField(field: string, value: unknown): void;
          }
        | undefined;
      const listed = presence?.getLocalState()?.agents ?? [];
      if (presence && !listed.some((a) => a.client === client))
        presence.setLocalStateField('agents', [
          ...listed,
          { client, name: author.name, color: author.color },
        ]);
      // Made as the assistant's own Yjs client: its text is its own in the document.
      applyTextDiffAs(doc, 'content', content, client, new AuthoredChange(author));
      return content;
    } finally {
      handle.dispose();
    }
  };

  /** File access for an assistant's requests: notes are read and written in their documents. */
  const filesAs = (root: string, author: ChangeAuthor): AgentFiles => ({
    root,
    read: async (path) => documents.peek(path) ?? (await vault.read(path)),
    write: (path, content, base) => write(path, content, author, base),
  });

  return { write, filesAs };
}
