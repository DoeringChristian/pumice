import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import type { MarkdownSyntaxApi, MenuEntry, VaultPath, WorkspaceApi } from '@pumice/api';
import { button, createIcon, h } from '@pumice/ui';
import { age, type ChatSummary } from './chats';
import type { AgentChange } from './ledger';
import {
  chatName,
  chatState,
  type ChatManager,
  type ChatState,
  type OpenChat,
  type Queued,
} from './manager';
import { vaultPathOf, type AgentConfig, type ChatSession, type TranscriptItem } from './session';

/** Text attached to the next prompt (a selection, a comment thread, the current note). */
export interface Attachment {
  label: string;
  blocks: ContentBlock[];
}

export interface AgentPanelDeps {
  workspace: WorkspaceApi;
  syntax: MarkdownSyntaxApi;
  agents(): AgentConfig[];
  /** Whether any agent can run here (desktop). */
  available: boolean;
  root: string;
  /** The chats that are open; the panel shows one of them. */
  manager: ChatManager;
  newChat(agentId: string): OpenChat;
  /** Saved conversations, most recent first. */
  listChats(): Promise<ChatSummary[]>;
  /** Opens a saved conversation again (undefined if it cannot be opened). */
  resumeChat(id: string): Promise<OpenChat | undefined>;
  /** Opens a copy of a chat that starts with everything said in it. */
  forkChat(id: string, name?: string): OpenChat | undefined;
  /** Stops a chat's agent; the conversation stays among the earlier ones. */
  closeChat(id: string): void;
  renameChat(id: string, name: string): void;
  deleteChat(id: string): Promise<void>;
  /** The chat the panel showed last. */
  lastChat(): string | undefined;
  setLastChat(id: string): void;
  /** What the chats changed in a note, most recent first. */
  changesFor(path: VaultPath): AgentChange[];
  undoChange(change: AgentChange): Promise<void>;
  currentAgent(): string;
  setCurrentAgent(id: string): void;
  /** Attachment for the active note (offered by default). */
  currentNote(): Attachment | undefined;
}

/** State shared between commands ("Ask agent about selection") and the panel. */
export class AgentPanelState {
  attachments: Attachment[] = [];
  /** Passages of the agent's answers the next message replies to. */
  quotes: string[] = [];
  draft = '';
  listeners = new Set<() => void>();
  fire() {
    this.listeners.forEach((l) => l());
  }
}

const TOOL_ICONS: Record<string, string> = {
  read: 'eye',
  edit: 'pencil',
  delete: 'trash',
  move: 'arrow-right',
  search: 'search',
  execute: 'zap',
  think: 'lightbulb',
  fetch: 'download',
};

function lineDiff(oldText: string, newText: string): HTMLElement {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const pre = h('pre', { class: 'pm-agent-diff' });
  const line = (cls: string, sign: string, text: string) =>
    pre.append(h('div', { class: cls }, `${sign} ${text}`));
  if (start > 0) line('is-context', ' ', a[start - 1]!);
  for (const l of a.slice(start, endA)) line('is-removed', '-', l);
  for (const l of b.slice(start, endB)) line('is-added', '+', l);
  if (endA < a.length) line('is-context', ' ', a[endA]!);
  return pre;
}

/** A message that replies to passages: each as a Markdown quote, then the message. */
export function withQuotes(quotes: string[], text: string): string {
  const blocks = quotes.map((q) =>
    q
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n'),
  );
  return [...blocks, text].join('\n\n');
}

/** The quotes a message starts with, and the rest of it. */
export function splitQuotes(text: string): { quotes: string[]; rest: string } {
  const quotes: string[] = [];
  let rest = text;
  for (;;) {
    const m = /^((?:>.*(?:\n|$))+)\n*/.exec(rest);
    if (!m) break;
    quotes.push(
      m[1]!
        .trimEnd()
        .split('\n')
        .map((line) => line.replace(/^> ?/, ''))
        .join('\n'),
    );
    rest = rest.slice(m[0].length);
  }
  return { quotes, rest };
}

export function renderAgentPanel(
  container: HTMLElement,
  deps: AgentPanelDeps,
  state: AgentPanelState,
) {
  const { workspace } = deps;
  const root = h('div', { class: 'pm-panel pm-agent' });
  container.append(root);
  if (!deps.available) {
    root.append(
      h(
        'div',
        { class: 'pm-panel-empty' },
        'The assistant runs in the desktop app, on your ChatGPT plan or through Claude Code, Codex or Gemini CLI on your computer.',
      ),
    );
    return { dispose() {} };
  }

  /**
   * A pill that shows the current choice and opens the app's menu with the others (native
   * select boxes look foreign here and are unreadable in a narrow sidebar).
   */
  const pill = (label: string, icon: string | undefined, cls = '') => {
    const text = h('span', { class: 'pm-agent-pill-text' });
    const button = h(
      'button',
      {
        class: `pm-agent-pill ${cls}`,
        type: 'button',
        'aria-label': label,
        'aria-haspopup': 'menu',
      },
      icon ? createIcon(icon, 13) : null,
      text,
      createIcon('chevron-down', 12),
    );
    let options: Array<{ id: string; name: string }> = [];
    let current: string | undefined;
    let pick: (id: string) => void = () => undefined;
    button.addEventListener('click', () => {
      const r = button.getBoundingClientRect();
      workspace.showContextMenu(
        options.map((o) => ({
          label: o.name,
          checked: o.id === current,
          run: () => pick(o.id),
        })),
        { x: r.left, y: r.bottom + 4 },
      );
    });
    return {
      button,
      set(
        opts: Array<{ id: string; name: string }>,
        value: string | undefined,
        onPick: (id: string) => void,
      ) {
        options = opts;
        current = value;
        pick = onPick;
        const name = opts.find((o) => o.id === value)?.name ?? label;
        text.textContent = name;
        button.title = `${label}: ${name}`;
        button.hidden = opts.length === 0;
      },
    };
  };
  const modelPill = pill('Model', undefined);
  const modePill = pill('Mode', undefined);
  // The chat on screen: its name opens the list of all chats.
  const chatDot = h('span', { class: 'pm-agent-dot' });
  const chatTitleEl = h('span', { class: 'pm-agent-chat-title' });
  const chatBadge = h('span', { class: 'pm-agent-chat-badge', hidden: true });
  const chatButton = h(
    'button',
    { class: 'pm-agent-chat-button', type: 'button', 'aria-haspopup': 'listbox' },
    chatDot,
    chatTitleEl,
    chatBadge,
    createIcon('chevron-down', 12),
  );
  const chatList = h('div', { class: 'pm-agent-chatlist', role: 'listbox', hidden: true });
  const status = h('span', { class: 'pm-agent-status' });
  const changesButton = h(
    'button',
    {
      class: 'pm-icon-button',
      title: 'What the agents changed in this note',
      'aria-label': 'What the agents changed in this note',
      hidden: true,
    },
    createIcon('history', 15),
  );
  const newChat = h(
    'button',
    { class: 'pm-icon-button', title: 'New chat', 'aria-label': 'New chat' },
    createIcon('plus', 15),
  );
  const transcript = h('div', { class: 'pm-panel-scroll pm-agent-transcript', role: 'log' });
  const queueEl = h('div', { class: 'pm-agent-queue', hidden: true });
  const chips = h('div', { class: 'pm-agent-chips' });
  const input = h('textarea', {
    class: 'pm-agent-input',
    rows: 3,
    placeholder: 'Ask the agent… (Enter to send, Shift+Enter for a new line)',
    'aria-label': 'Message',
  });
  const send = h(
    'button',
    { class: 'pm-button is-primary pm-agent-send', title: 'Send' },
    createIcon('send', 14),
  );
  const stop = h(
    'button',
    { class: 'pm-button pm-agent-stop', title: 'Stop', hidden: true },
    createIcon('square', 12),
    ' Stop',
  );
  root.append(
    h(
      'div',
      { class: 'pm-panel-toolbar pm-agent-toolbar' },
      chatButton,
      status,
      changesButton,
      newChat,
    ),
    chatList,
    transcript,
    h(
      'div',
      { class: 'pm-agent-composer' },
      queueEl,
      chips,
      input,
      h(
        'div',
        { class: 'pm-agent-composer-actions' },
        modelPill.button,
        modePill.button,
        h('span', { class: 'pm-agent-composer-spacer' }),
        stop,
        send,
      ),
    ),
  );

  const { manager } = deps;
  let chat: OpenChat | undefined;
  let session: ChatSession | undefined;
  let sub: { dispose(): void } | undefined;
  let includeNote = true;

  const used = (c: OpenChat) =>
    c.queue.length > 0 || c.session.items.some((i) => i.kind === 'user');

  /** Shows a chat. The one shown before keeps running. */
  const attach = (next: OpenChat | undefined) => {
    const previous = chat;
    sub?.dispose();
    chat = next;
    session = next?.session;
    // A chat nothing was said in is not kept around.
    if (previous && previous !== next && !used(previous) && manager.get(previous.session.chatId))
      deps.closeChat(previous.session.chatId);
    manager.show(session?.chatId);
    if (session) {
      deps.setLastChat(session.chatId);
      deps.setCurrentAgent(session.config.id);
    }
    sub = session?.onDidChange(() => scheduleRender());
    render();
  };
  const startChat = (agentId = session?.config.id ?? deps.currentAgent()) => {
    attach(deps.newChat(agentId));
    // After the menu it was picked from has given the focus back.
    setTimeout(() => input.focus(), 60);
  };
  // Select part of an answer: a button offers to reply to just that passage.
  let quoteButton: HTMLElement | undefined;
  const hideQuoteButton = () => {
    quoteButton?.remove();
    quoteButton = undefined;
  };
  const selectedAnswerText = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return undefined;
    const inAnswer = (node: Node | null) =>
      !!(node instanceof Element ? node : node?.parentElement)?.closest('.pm-agent-msg.is-agent');
    if (
      !transcript.contains(sel.anchorNode) ||
      !inAnswer(sel.anchorNode) ||
      !inAnswer(sel.focusNode)
    )
      return undefined;
    const text = sel.toString().trim();
    return text
      ? { text: text.slice(0, 4000), rect: sel.getRangeAt(0).getBoundingClientRect() }
      : undefined;
  };
  transcript.addEventListener('mouseup', () => {
    // After the browser has settled the selection.
    setTimeout(() => {
      hideQuoteButton();
      const picked = selectedAnswerText();
      if (!picked) return;
      const el = h(
        'button',
        { class: 'pm-agent-quote-button', type: 'button', title: 'Reply to the selected text' },
        createIcon('quote', 13),
        ' Reply',
      );
      // Keep the selection while the button is pressed.
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => {
        const now = selectedAnswerText();
        if (now) state.quotes.push(now.text);
        document.getSelection()?.removeAllRanges();
        hideQuoteButton();
        renderChips();
        input.focus();
      });
      root.append(el);
      const box = root.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(picked.rect.right - box.left - 40, box.width - el.offsetWidth - 8),
      );
      const below = picked.rect.bottom - box.top + 6;
      el.style.left = `${left}px`;
      el.style.top = `${below + el.offsetHeight > box.height ? picked.rect.top - box.top - el.offsetHeight - 6 : below}px`;
      quoteButton = el;
    });
  });
  transcript.addEventListener('scroll', hideQuoteButton, { passive: true });
  const onSelectionGone = () => {
    if (quoteButton && document.getSelection()?.isCollapsed) hideQuoteButton();
  };
  document.addEventListener('selectionchange', onSelectionGone);

  // ---- the list of chats -------------------------------------------------------------------

  const STATE_TEXT: Record<ChatState, string> = {
    starting: 'Starting…',
    working: 'Working…',
    permission: 'Waiting for your OK',
    unread: 'New answer',
    idle: '',
    error: 'Stopped',
  };
  const agentName = (id: string) =>
    deps
      .agents()
      .find((a) => a.id === id)
      ?.name.replace(/\s*\(.*\)$/, '') ?? id;

  let listOpen = false;
  let renaming: string | undefined;
  const outsideList = (e: MouseEvent) => {
    const target = e.target as Node;
    if (!chatList.contains(target) && !chatButton.contains(target)) closeList();
  };
  const closeList = () => {
    listOpen = false;
    renaming = undefined;
    chatList.hidden = true;
    document.removeEventListener('mousedown', outsideList, true);
  };
  const renderList = async () => {
    const saved = await deps.listChats();
    if (!listOpen) return;
    const open = [...manager.open].reverse();
    const openIds = new Set(open.map((c) => c.session.chatId));
    const earlier = saved.filter((c) => !openIds.has(c.id)).slice(0, 30);
    const heading = (text: string) => h('div', { class: 'pm-agent-chatlist-heading' }, text);
    const row = (o: {
      id: string;
      title: string;
      detail: string;
      state?: ChatState;
      current?: boolean;
      disabled?: boolean;
      pick(): void;
      menu(): MenuEntry[];
    }) => {
      const title =
        renaming === o.id
          ? (() => {
              const box = h('input', {
                class: 'pm-agent-chatlist-rename',
                value: o.title,
                'aria-label': 'Name of the chat',
              });
              const done = (keep: boolean) => {
                if (renaming !== o.id) return;
                renaming = undefined;
                if (keep) deps.renameChat(o.id, box.value);
                void renderList();
              };
              box.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  done(false);
                }
              });
              // The menu "Rename" was picked from takes the focus back once: stay in the box.
              const born = Date.now();
              box.addEventListener('blur', () => {
                if (Date.now() - born < 300) setTimeout(() => box.focus(), 30);
                else done(true);
              });
              box.addEventListener('click', (e) => e.stopPropagation());
              setTimeout(() => (box.focus(), box.select()));
              return box;
            })()
          : h('span', { class: 'pm-agent-chatlist-title' }, o.title);
      const more = h(
        'button',
        { class: 'pm-agent-chatlist-more', title: 'More', 'aria-label': `More for ${o.title}` },
        createIcon('more-vertical', 13),
      );
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        workspace.showContextMenu(o.menu(), { x: Math.max(8, r.right - 180), y: r.bottom + 4 });
      });
      const el = h(
        'div',
        {
          class: `pm-agent-chatlist-row${o.current ? ' is-current' : ''}${o.disabled ? ' is-disabled' : ''}`,
          role: 'option',
          tabindex: 0,
          'aria-selected': !!o.current,
        },
        h('span', { class: 'pm-agent-dot', 'data-state': o.state ?? 'closed' }),
        h(
          'span',
          { class: 'pm-agent-chatlist-text' },
          title,
          h('span', { class: 'pm-agent-chatlist-detail' }, o.detail),
        ),
        more,
      );
      const pick = () => {
        if (o.disabled || renaming === o.id) return;
        closeList();
        o.pick();
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === el) pick();
      });
      return el;
    };
    const remove = (id: string, title: string): MenuEntry => ({
      label: 'Delete',
      icon: 'trash',
      danger: true,
      run: () => {
        void workspace
          .confirm(`Delete the chat “${title}”? This cannot be undone.`, {
            confirmLabel: 'Delete',
            danger: true,
          })
          .then((ok) => (ok ? deps.deleteChat(id) : undefined))
          .then(() => (listOpen ? renderList() : undefined));
      },
    });
    chatList.replaceChildren(
      ...(open.length ? [heading('Open')] : []),
      ...open.map((c) => {
        const id = c.session.chatId;
        const state = chatState(c);
        return row({
          id,
          title: chatName(c),
          detail: [agentName(c.session.config.id), STATE_TEXT[state]].filter(Boolean).join(' · '),
          state,
          current: c === chat,
          pick: () => attach(c),
          menu: () => [
            {
              label: 'Rename',
              icon: 'pencil',
              run: () => {
                // Picking from the menu closed the list: the name is edited in its row.
                renaming = id;
                openList();
              },
            },
            {
              label: 'Fork',
              icon: 'copy',
              run: () => {
                const fork = deps.forkChat(id);
                if (fork) attach(fork);
              },
            },
            {
              label: 'Close (stops its agent)',
              icon: 'x',
              run: () => deps.closeChat(id),
            },
            remove(id, chatName(c)),
          ],
        });
      }),
      ...(earlier.length ? [heading('Earlier')] : []),
      ...earlier.map((c) => {
        const usable = deps.agents().some((a) => a.id === c.agent);
        return row({
          id: c.id,
          title: c.title,
          detail: `${agentName(c.agent)} · ${age(c.updated)}`,
          disabled: !usable,
          pick: () => void deps.resumeChat(c.id).then((resumed) => resumed && attach(resumed)),
          menu: () => [remove(c.id, c.title)],
        });
      }),
      ...(open.length || earlier.length
        ? []
        : [h('div', { class: 'pm-agent-chatlist-empty' }, 'No chats yet.')]),
    );
  };
  const openList = () => {
    if (!listOpen) document.addEventListener('mousedown', outsideList, true);
    listOpen = true;
    chatList.hidden = false;
    void renderList();
  };
  chatButton.addEventListener('click', () => (listOpen ? closeList() : openList()));
  chatList.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeList();
  });

  newChat.addEventListener('click', () => {
    closeList();
    const list = deps.agents();
    if (list.length <= 1) return startChat(list[0]?.id);
    const r = newChat.getBoundingClientRect();
    workspace.showContextMenu(
      list.map((a) => ({ label: `New chat with ${a.name}`, run: () => startChat(a.id) })),
      { x: Math.max(8, r.right - 240), y: r.bottom + 4 },
    );
  });

  const snippet = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
  };
  changesButton.addEventListener('click', () => {
    const path = workspace.activeFile;
    if (!path) return;
    const r = changesButton.getBoundingClientRect();
    const entries: MenuEntry[] = deps
      .changesFor(path)
      .slice(0, 15)
      .map((c) => {
        const what = c.inserted.trim()
          ? `“${snippet(c.inserted)}”`
          : c.removed.trim()
            ? `removed “${snippet(c.removed)}”`
            : 'a large change';
        return {
          label: `${snippet(c.chat)} · ${age(c.time)} · ${what}`,
          run: () => {
            void workspace
              .confirm(
                `Take back this change by “${c.chat}”?\n\n${c.removed.trim() ? `Brings back: “${snippet(c.removed)}”\n` : ''}${c.inserted.trim() ? `Removes: “${snippet(c.inserted)}”` : ''}`,
                { confirmLabel: 'Take back' },
              )
              .then((ok) => (ok ? deps.undoChange(c) : undefined))
              .then(renderBar);
          },
        };
      });
    workspace.showContextMenu(
      [{ label: `Changes by agents in ${path}`, disabled: true, run: () => undefined }, ...entries],
      { x: Math.max(8, r.right - 320), y: r.bottom + 4 },
    );
  });

  const renderBar = () => {
    chatTitleEl.textContent = chat ? chatName(chat) : 'No chat';
    chatDot.dataset.state = chat ? chatState(chat) : 'closed';
    const waiting = manager.waiting();
    chatBadge.hidden = !waiting;
    chatBadge.textContent = String(waiting);
    chatButton.title = waiting
      ? `Chats (${waiting} other ${waiting === 1 ? 'chat wants' : 'chats want'} your attention)`
      : 'Chats';
    const path = workspace.activeFile;
    changesButton.hidden = !path || deps.changesFor(path).length === 0;
  };
  const listSub = manager.onDidChange(() => {
    // Closed from elsewhere (its row's menu): show another one.
    if (chat && !manager.get(chat.session.chatId)) {
      chat = undefined;
      return attach(manager.open[manager.open.length - 1]);
    }
    renderBar();
    renderQueue();
    if (listOpen && !renaming) void renderList();
  });

  // Messages written while the agent is busy wait their turn.
  const renderQueue = () => {
    const waiting = chat?.queue ?? [];
    queueEl.hidden = !waiting.length;
    queueEl.replaceChildren(
      ...waiting.map((item, i) =>
        h(
          'div',
          { class: 'pm-agent-queued', title: item.message },
          h('span', { class: 'pm-agent-queued-label' }, i === 0 ? 'Next' : 'Queued'),
          h('span', { class: 'pm-agent-queued-text' }, item.message.replace(/\s+/g, ' ')),
          h(
            'button',
            {
              class: 'pm-agent-chip-remove',
              title: 'Don’t send this',
              'aria-label': 'Don’t send this',
              onclick: () => chat && manager.unqueue(chat, i),
            },
            createIcon('x', 11),
          ),
        ),
      ),
    );
  };

  /**
   * Sends what is in the input. While the agent is working the message waits in the queue;
   * with `interrupt` the agent is stopped and the message goes next.
   */
  const submit = (interrupt = false) => {
    const text = input.value.trim();
    if (!text) return;
    commandList.hidden = true;
    matches = [];
    // Commands about the chat itself: done here, not sent to the agent.
    const own = /^\/(new|rename|fork|close|delete)(?:\s+([\s\S]*))?$/.exec(text);
    if (own && runOwnCommand(own[1]!, (own[2] ?? '').trim())) {
      input.value = '';
      state.draft = '';
      return;
    }
    if (!chat || !session || session.status === 'closed' || session.status === 'error') {
      if (chat && session?.status === 'closed') deps.closeChat(chat.session.chatId);
      startChat();
    }
    const note = includeNote ? deps.currentNote() : undefined;
    const atts = [...(note ? [note] : []), ...state.attachments];
    const item: Queued = {
      message: withQuotes(state.quotes, text),
      blocks: atts.flatMap((a) => a.blocks),
      label: atts.map((a) => a.label).join(', ') || undefined,
    };
    input.value = '';
    state.draft = '';
    state.attachments = [];
    state.quotes = [];
    renderChips();
    // While the agent is busy the message waits its turn.
    manager.send(chat!, item, interrupt);
    renderQueue();
  };
  /** `/new`, `/rename`, `/fork`, `/close`, `/delete`. False if it could not be done. */
  const runOwnCommand = (name: string, arg: string): boolean => {
    if (name === 'new') {
      startChat();
      return true;
    }
    if (!chat) {
      workspace.notify('There is no chat open yet.', { kind: 'warning' });
      return false;
    }
    const id = chat.session.chatId;
    if (name === 'rename') {
      if (!arg) {
        workspace.notify('Write the new name after /rename.', { kind: 'warning' });
        return false;
      }
      deps.renameChat(id, arg);
    } else if (name === 'fork') {
      const fork = deps.forkChat(id, arg || undefined);
      if (!fork) return false;
      attach(fork);
      workspace.notify(`Forked: “${chatName(fork)}” starts with this conversation.`, {
        timeout: 4000,
      });
    } else if (name === 'close') deps.closeChat(id);
    else if (name === 'delete') {
      const title = chatName(chat);
      void workspace
        .confirm(`Delete the chat “${title}”? This cannot be undone.`, {
          confirmLabel: 'Delete',
          danger: true,
        })
        .then((ok) => (ok ? deps.deleteChat(id) : undefined));
    }
    return true;
  };
  send.addEventListener('click', () => submit());
  stop.addEventListener('click', () => session?.cancel());
  // ---- slash commands: "/" at the start of the message lists what the agent understands -----

  const commandList = h('div', { class: 'pm-agent-commands', role: 'listbox', hidden: true });
  input.before(commandList);
  let matches: Array<{ name: string; description: string; hint?: string }> = [];
  let selected = 0;
  const allCommands = () => [
    ...(session?.commands ?? []),
    // Work with every agent: handled here, not sent.
    { name: 'new', description: 'Start a new chat with this agent' },
    { name: 'rename', description: 'Give this chat a name', hint: 'the name' },
    {
      name: 'fork',
      description: 'Continue in a second chat that starts with this conversation',
      hint: 'a name (optional)',
    },
    { name: 'close', description: 'Stop this chat’s agent; the chat stays under Earlier' },
    { name: 'delete', description: 'Delete this chat' },
  ];
  const renderCommands = () => {
    const typed = /^\/([\w-]*)$/.exec(input.value);
    matches = typed
      ? allCommands().filter((c) => c.name.toLowerCase().startsWith(typed[1]!.toLowerCase()))
      : [];
    commandList.hidden = matches.length === 0;
    if (selected >= matches.length) selected = 0;
    commandList.replaceChildren(
      ...matches.map((c, i) =>
        h(
          'button',
          {
            class: `pm-agent-command${i === selected ? ' is-selected' : ''}`,
            role: 'option',
            'aria-selected': i === selected,
            // mousedown: keep the focus in the text box
            onmousedown: (e: MouseEvent) => {
              e.preventDefault();
              pickCommand(c.name);
            },
          },
          h('span', { class: 'pm-agent-command-name' }, `/${c.name}`),
          h(
            'span',
            { class: 'pm-agent-command-desc' },
            c.hint ? `${c.description} — ${c.hint}` : c.description,
          ),
        ),
      ),
    );
  };
  const pickCommand = (name: string) => {
    input.value = `/${name} `;
    state.draft = input.value;
    renderCommands();
    input.focus();
  };

  input.addEventListener('keydown', (e) => {
    if (matches.length && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selected = (selected + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        return renderCommands();
      }
      // Tab completes; Enter completes too unless the command is already typed out.
      const exact = matches[selected]!.name === input.value.slice(1);
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
        e.preventDefault();
        return pickCommand(matches[selected]!.name);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        matches = [];
        commandList.hidden = true;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Cmd/Ctrl+Enter: stop what the agent is doing and send this now.
      submit(e.metaKey || e.ctrlKey);
    }
  });
  input.addEventListener('input', () => {
    state.draft = input.value;
    renderCommands();
  });
  input.addEventListener('blur', () => (commandList.hidden = true));

  const renderChips = () => {
    chips.replaceChildren();
    const note = deps.currentNote();
    if (note) {
      const chip = h(
        'button',
        {
          class: `pm-agent-chip${includeNote ? '' : ' is-off'}`,
          title: includeNote
            ? 'The current note is sent as context (click to leave it out)'
            : 'Click to send the current note as context',
          onclick: () => {
            includeNote = !includeNote;
            renderChips();
          },
        },
        createIcon('file-text', 12),
        ` ${note.label}`,
      );
      chips.append(chip);
    }
    state.quotes.forEach((q, i) => {
      chips.append(
        h(
          'span',
          { class: 'pm-agent-chip is-quote', title: q },
          createIcon('quote', 12),
          h('span', { class: 'pm-agent-chip-text' }, q.replace(/\s+/g, ' ')),
          h(
            'button',
            {
              class: 'pm-agent-chip-remove',
              title: 'Remove',
              onclick: () => {
                state.quotes.splice(i, 1);
                renderChips();
              },
            },
            createIcon('x', 11),
          ),
        ),
      );
    });
    state.attachments.forEach((a, i) => {
      chips.append(
        h(
          'span',
          { class: 'pm-agent-chip' },
          createIcon('map-pin', 12),
          ` ${a.label} `,
          h(
            'button',
            {
              class: 'pm-agent-chip-remove',
              title: 'Remove',
              onclick: () => {
                state.attachments.splice(i, 1);
                renderChips();
              },
            },
            createIcon('x', 11),
          ),
        ),
      );
    });
  };

  const openLocation = (abs: string) => {
    const p = vaultPathOf(deps.root, abs);
    if (p !== abs) void workspace.openFile(p as VaultPath);
  };

  const toolContent = (c: ToolCallContent): HTMLElement | null => {
    if (c.type === 'diff') {
      return h(
        'div',
        { class: 'pm-agent-tool-diff' },
        h(
          'button',
          { class: 'pm-agent-link', onclick: () => openLocation(c.path) },
          vaultPathOf(deps.root, c.path),
        ),
        lineDiff(c.oldText ?? '', c.newText),
      );
    }
    if (c.type === 'content' && c.content.type === 'text') {
      return h('pre', { class: 'pm-agent-tool-output' }, c.content.text.slice(0, 4000));
    }
    // What the agent was shown (a drawing as it looked after its change).
    if (c.type === 'content' && c.content.type === 'image') {
      return h('img', {
        class: 'pm-agent-tool-image',
        alt: 'What the agent was shown',
        src: `data:${c.content.mimeType};base64,${c.content.data}`,
      });
    }
    return null;
  };

  const item = (it: TranscriptItem): HTMLElement => {
    switch (it.kind) {
      case 'user':
        return h(
          'div',
          { class: 'pm-agent-msg is-user' },
          it.context
            ? h(
                'div',
                { class: 'pm-agent-msg-context' },
                createIcon('map-pin', 11),
                ` ${it.context}`,
              )
            : null,
          ...(() => {
            // Replies to passages of an answer show them as quotes.
            const { quotes, rest } = splitQuotes(it.text);
            return [
              ...quotes.map((q) => h('blockquote', { class: 'pm-agent-msg-quote' }, q)),
              h('div', { class: 'pm-agent-msg-text' }, rest),
            ];
          })(),
        );
      case 'agent': {
        const el = h('div', { class: 'pm-agent-msg is-agent pm-rendered' });
        el.innerHTML = deps.syntax.renderHtml(deps.syntax.parse(it.text));
        return el;
      }
      case 'thought':
        return h(
          'details',
          { class: 'pm-agent-thought' },
          h('summary', {}, 'Thinking'),
          h('div', { class: 'pm-agent-thought-text' }, it.text),
        );
      case 'tool': {
        const content = it.content.map(toolContent).filter((x): x is HTMLElement => !!x);
        return h(
          'details',
          {
            class: `pm-agent-tool is-${it.status}`,
            open:
              it.status === 'pending' ||
              content.some((c) => c.classList.contains('pm-agent-tool-diff')),
          },
          h(
            'summary',
            {},
            createIcon(TOOL_ICONS[it.toolKind ?? ''] ?? 'zap', 13),
            h('span', { class: 'pm-agent-tool-title' }, it.title),
            h('span', { class: 'pm-agent-tool-status' }, it.status.replace('_', ' ')),
          ),
          // Diffs show their own file; list only the other locations.
          ...it.locations
            .filter((l) => !it.content.some((c) => c.type === 'diff' && c.path === l))
            .map((l) =>
              h(
                'button',
                { class: 'pm-agent-link', onclick: () => openLocation(l) },
                vaultPathOf(deps.root, l),
              ),
            ),
          ...content,
        );
      }
      case 'plan':
        return h(
          'ul',
          { class: 'pm-agent-plan' },
          ...it.entries.map((e) =>
            h(
              'li',
              { class: `is-${e.status}` },
              createIcon(e.status === 'completed' ? 'check-square' : 'square', 13),
              ` ${e.content}`,
            ),
          ),
        );
      case 'permission':
        return h(
          'div',
          { class: 'pm-agent-permission' },
          h('div', { class: 'pm-agent-permission-title' }, it.title),
          it.chosen
            ? h(
                'div',
                { class: 'pm-agent-permission-result' },
                it.chosen === 'cancelled'
                  ? 'Cancelled'
                  : `→ ${it.options.find((o) => o.optionId === it.chosen)?.name ?? it.chosen}`,
              )
            : h(
                'div',
                { class: 'pm-agent-permission-options' },
                ...it.options.map((o) =>
                  button(o.name, () => it.respond?.(o.optionId), {
                    kind: o.kind.startsWith('allow') ? 'primary' : 'plain',
                  }),
                ),
              ),
        );
      case 'error':
        return h('div', { class: 'pm-agent-error' }, it.text);
      case 'info':
        return h('div', { class: 'pm-agent-info' }, it.text);
    }
  };

  let frame = 0;
  const scheduleRender = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  const render = () => {
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    const config = session?.config ?? deps.agents().find((a) => a.id === deps.currentAgent());
    status.textContent = session
      ? {
          starting: 'Starting…',
          ready: 'Ready',
          working: 'Working…',
          closed: 'Stopped',
          error: 'Error',
        }[session.status]
      : '';
    if (session?.status === 'error' && session.loginOptions.length)
      status.textContent = 'Sign in needed';
    status.dataset.status = session?.status ?? '';
    stop.hidden = session?.status !== 'working';
    const busy = session?.status === 'working';
    send.title = busy ? 'Queue this message (⌘/Ctrl+Enter: stop the agent and send now)' : 'Send';
    input.placeholder = busy
      ? 'Write the next message… (Enter queues it, ⌘/Ctrl+Enter interrupts and sends)'
      : 'Ask the agent… (Enter to send, Shift+Enter for a new line)';
    renderQueue();
    renderBar();
    modelPill.set(session?.models ?? [], session?.currentModel, (id) => void session?.setModel(id));
    modePill.set(session?.modes ?? [], session?.currentMode, (id) => void session?.setMode(id));
    const items = session?.items ?? [];
    if (!items.length) {
      transcript.replaceChildren(
        h(
          'div',
          { class: 'pm-panel-empty' },
          session?.status === 'starting'
            ? `Starting ${config?.name ?? 'the agent'}…`
            : `Ask ${config?.name ?? 'an agent'} about your notes. It works in this vault folder; edits to open notes show up live.`,
        ),
      );
    } else {
      transcript.replaceChildren(...items.map(item));
      if (session?.status === 'error' && session.loginOptions.length) {
        transcript.append(
          h(
            'div',
            { class: 'pm-agent-permission' },
            h('div', { class: 'pm-agent-permission-title' }, 'Sign in'),
            h(
              'div',
              { class: 'pm-agent-permission-options' },
              ...session.loginOptions.map((m) =>
                button(m.name, () => void session!.authenticate(m.id), { kind: 'primary' }),
              ),
            ),
          ),
        );
      }
    }
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  };

  const onState = () => {
    if (state.draft && !input.value) input.value = state.draft;
    renderChips();
    input.focus();
  };
  state.listeners.add(onState);
  const activeSub = workspace.onDidChangeActiveFile(() => renderChips());

  input.value = state.draft;
  renderChips();
  const begin = async () => {
    const running = manager.active ?? manager.open[manager.open.length - 1];
    if (running) return attach(running);
    // The built-in assistant has nothing to launch: pick up its last chat right away.
    const builtIn = (id: string) => deps.agents().find((a) => a.id === id)?.kind === 'chatgpt';
    const last = deps.lastChat();
    if (last) {
      const summary = (await deps.listChats()).find((c) => c.id === last);
      const resumed = summary && builtIn(summary.agent) ? await deps.resumeChat(last) : undefined;
      if (chat) return;
      if (resumed) return attach(resumed);
    }
    if (builtIn(deps.currentAgent())) startChat(deps.currentAgent());
  };
  render();
  void begin();

  return {
    focus() {
      input.focus();
    },
    dispose() {
      state.listeners.delete(onState);
      activeSub.dispose();
      sub?.dispose();
      listSub.dispose();
      closeList();
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onSelectionGone);
      hideQuoteButton();
    },
  };
}
