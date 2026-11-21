import { Emitter, type PlatformFs, type VaultPath } from '@pumice/api';
import { CHATS_DIR } from './chats';
import type { AgentFiles } from './session';

/**
 * What the chats did to the notes: which chat changed which text (so a change can be traced
 * back and taken back, and a comment on a passage reaches the chat that wrote it), and which
 * chat answers which comment thread.
 */

/** Smallest single replacement turning `a` into `b`. */
export function minimalChange(
  a: string,
  b: string,
): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export interface AgentChange {
  id: string;
  path: VaultPath;
  chatId: string;
  /** What the chat was called when it made the change. */
  chat: string;
  /** ISO timestamp. */
  time: string;
  /** The text that was replaced, and what replaced it. */
  removed: string;
  inserted: string;
  /** The text right before and after, to find the place again. */
  prefix: string;
  suffix: string;
}

const CONTEXT = 40;
const MAX_CHANGES = 300;
/** Larger changes are listed, but their text is not kept (they cannot be taken back). */
const MAX_TEXT = 20_000;
const FILE = `${CHATS_DIR}/ledger.json`;

/** Where a recorded change is in `text` now, if its text is still there as the chat left it. */
export function locateChange(
  change: AgentChange,
  text: string,
): { from: number; to: number } | undefined {
  const once = (needle: string, offset: number) => {
    if (!needle) return undefined;
    const at = text.indexOf(needle);
    // Found twice: there is no telling which one it was.
    if (at < 0 || text.indexOf(needle, at + 1) >= 0) return undefined;
    return { from: at + offset, to: at + offset + change.inserted.length };
  };
  const { prefix, inserted, suffix } = change;
  // The surroundings may have been edited since: less of them is tried in turn.
  return (
    once(prefix + inserted + suffix, prefix.length) ??
    once(prefix + inserted, prefix.length) ??
    once(inserted + suffix, 0) ??
    (inserted.trim().length >= 12 ? once(inserted, 0) : undefined)
  );
}

/** `text` with the change taken back, or undefined if the place has changed since. */
export function revertChange(change: AgentChange, text: string): string | undefined {
  if (change.removed.length > MAX_TEXT || change.inserted.length > MAX_TEXT) return undefined;
  const at = locateChange(change, text);
  return at ? text.slice(0, at.from) + change.removed + text.slice(at.to) : undefined;
}

export class Ledger {
  private changes: AgentChange[] = [];
  private threads: Record<string, string> = {};
  private loaded: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly fs: PlatformFs) {}

  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        if (!(await this.fs.stat(FILE))) return;
        const data = JSON.parse(await this.fs.readText(FILE)) as {
          changes?: AgentChange[];
          threads?: Record<string, string>;
        };
        if (Array.isArray(data.changes)) this.changes = [...data.changes, ...this.changes];
        if (data.threads && typeof data.threads === 'object')
          this.threads = { ...data.threads, ...this.threads };
      } catch {
        // Unreadable: start over; only the history of changes is lost.
      }
    })();
    return this.loaded;
  }

  private touch(): void {
    this.changed.fire();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1500);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.load();
    const data = { changes: this.changes, threads: this.threads };
    await this.fs
      .write(FILE, `${JSON.stringify(data)}\n`)
      .catch((e: unknown) => console.error('[pumice] could not save the agents’ changes', e));
  }

  /** Notes that `chatId` turned `before` into `after`. */
  record(path: VaultPath, chatId: string, chat: string, before: string, after: string): void {
    const c = minimalChange(before, after);
    if (!c) return;
    const removed = before.slice(c.from, c.to);
    const big = removed.length > MAX_TEXT || c.insert.length > MAX_TEXT;
    this.changes.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      chatId,
      chat,
      time: new Date().toISOString(),
      removed: big ? '' : removed,
      inserted: big ? '' : c.insert,
      prefix: big ? '' : before.slice(Math.max(0, c.from - CONTEXT), c.from),
      suffix: big ? '' : before.slice(c.to, c.to + CONTEXT),
    });
    this.changes.splice(0, this.changes.length - MAX_CHANGES);
    this.touch();
  }

  /** Changes to a note, most recent first. */
  changesFor(path: VaultPath): AgentChange[] {
    return this.changes.filter((c) => c.path === path).reverse();
  }

  forget(change: AgentChange): void {
    const at = this.changes.indexOf(change);
    if (at < 0) return;
    this.changes.splice(at, 1);
    this.touch();
  }

  /** The chat that last wrote something in `range` of the note's current `text`. */
  chatForRange(
    path: VaultPath,
    text: string,
    range: { from: number; to: number },
  ): string | undefined {
    for (const change of this.changesFor(path)) {
      if (!change.inserted.trim()) continue;
      const at = locateChange(change, text);
      if (at && at.from < Math.max(range.to, range.from + 1) && at.to > range.from)
        return change.chatId;
    }
    return undefined;
  }

  /** The chat that answers a comment thread (the one that answered it first). */
  threadChat(threadId: string): string | undefined {
    return this.threads[threadId];
  }

  setThreadChat(threadId: string, chatId: string): void {
    if (this.threads[threadId] === chatId) return;
    this.threads[threadId] = chatId;
    this.touch();
  }
}

export class StaleEditError extends Error {}

/**
 * A chat's own view of the files. A file that changed since the chat last saw it (another
 * chat's edit, or the user's) is not overwritten: the chat is told to read it again. What it
 * does write is noted in the ledger.
 */
export function trackedFiles(
  base: AgentFiles,
  ledger: Ledger,
  chat: () => { id: string; name: string },
): AgentFiles {
  const seen = new Map<VaultPath, string>();
  return {
    root: base.root,
    async read(path) {
      const text = await base.read(path);
      seen.set(path, text);
      return text;
    },
    async write(path, content) {
      const current = await base.read(path).catch(() => undefined);
      const known = seen.get(path);
      if (current !== undefined && known !== undefined && known !== current) {
        // Refused once: the next write counts as made on the text as it is now.
        seen.set(path, current);
        throw new StaleEditError(
          `${path} has changed since you last read it (someone else edited it). Read it again and make your change on the current text.`,
        );
      }
      await base.write(path, content);
      seen.set(path, content);
      const { id, name } = chat();
      if (/\.(md|markdown|txt)$/i.test(path)) ledger.record(path, id, name, current ?? '', content);
    },
  };
}
