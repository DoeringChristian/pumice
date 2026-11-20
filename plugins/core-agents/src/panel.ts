import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import type { MarkdownSyntaxApi, MenuEntry, VaultPath, WorkspaceApi } from '@pumice/api';
import { button, createIcon, h } from '@pumice/ui';
import { age, type ChatSummary } from './chats';
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
  sessionFor(agentId: string): ChatSession | undefined;
  startSession(agentId: string): ChatSession;
  /** Saved conversations, most recent first. */
  listChats(): Promise<ChatSummary[]>;
  /** Opens a saved conversation; resolves to its agent, or undefined if it cannot be opened. */
  resumeChat(id: string): Promise<string | undefined>;
  deleteChat(id: string): Promise<void>;
  /** The conversation last used with an agent. */
  lastChat(agentId: string): string | undefined;
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
  /** The agent the panel shows. */
  let agentId = deps.currentAgent();
  const agentPill = pill('Agent', 'bot', 'pm-agent-pill-agent');
  const modelPill = pill('Model', undefined);
  const modePill = pill('Mode', undefined);
  const status = h('span', { class: 'pm-agent-status' });
  const newChat = h(
    'button',
    { class: 'pm-icon-button', title: 'New chat', 'aria-label': 'New chat' },
    createIcon('plus', 15),
  );
  const history = h(
    'button',
    { class: 'pm-icon-button', title: 'Earlier chats', 'aria-label': 'Earlier chats' },
    createIcon('history', 15),
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
      agentPill.button,
      status,
      history,
      newChat,
    ),
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

  let session: ChatSession | undefined;
  let sub: { dispose(): void } | undefined;
  let includeNote = true;

  const attach = (id: string, start: boolean) => {
    sub?.dispose();
    session = deps.sessionFor(id);
    if (!session && start) {
      // Pick up where the last conversation with this agent stopped.
      const last = deps.lastChat(id);
      if (last) {
        void deps.resumeChat(last).then((resumed) => {
          if (agentId !== id) return;
          if (!resumed && !deps.sessionFor(id)) deps.startSession(id);
          attach(id, false);
        });
        render();
        return;
      }
      session = deps.startSession(id);
    }
    sub = session?.onDidChange(() => scheduleRender());
    render();
  };

  const selectAgent = (id: string) => {
    agentId = id;
    deps.setCurrentAgent(id);
    attach(id, deps.agents().find((a) => a.id === id)?.kind === 'chatgpt');
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

  history.addEventListener('click', () => {
    const r = history.getBoundingClientRect();
    void deps.listChats().then((chats) => {
      const names = new Map(deps.agents().map((a) => [a.id, a.name.replace(/\s*\(.*\)$/, '')]));
      const current = session?.chatId;
      const entries: MenuEntry[] = chats.slice(0, 30).map((c) => ({
        label: `${c.title}  ·  ${names.get(c.agent) ?? c.agent}, ${age(c.updated)}`,
        checked: c.id === current,
        disabled: !names.has(c.agent),
        run: () => {
          if (c.id === current) return;
          void deps.resumeChat(c.id).then((agent) => {
            if (!agent) return;
            agentId = agent;
            deps.setCurrentAgent(agent);
            attach(agent, false);
          });
        },
      }));
      if (!entries.length)
        entries.push({ label: 'No earlier chats', disabled: true, run: () => undefined });
      if (current && chats.some((c) => c.id === current)) {
        entries.push({
          label: 'Delete this chat',
          icon: 'trash',
          danger: true,
          run: () => {
            void deps.deleteChat(current).then(() => newChat.click());
          },
        });
      }
      workspace.showContextMenu(entries, { x: Math.max(8, r.right - 300), y: r.bottom + 4 });
    });
  });
  newChat.addEventListener('click', () => {
    session?.dispose();
    session = deps.startSession(agentId);
    attach(agentId, false);
  });

  // Messages written while the agent is busy wait their turn.
  interface Queued {
    message: string;
    blocks: ContentBlock[];
    label: string | undefined;
  }
  const queues = new WeakMap<ChatSession, Queued[]>();
  const watched = new WeakSet<ChatSession>();
  const handing = new WeakSet<ChatSession>();
  const queueOf = (s: ChatSession) => {
    let q = queues.get(s);
    if (!q) queues.set(s, (q = []));
    return q;
  };
  /** Sends the next waiting message once the agent is free. */
  const flush = (s: ChatSession) => {
    if (s.status !== 'ready' || handing.has(s)) return;
    const next = queueOf(s).shift();
    if (!next) return;
    renderQueue();
    // Starting a turn reports changes before the agent counts as busy: one message at a time.
    handing.add(s);
    try {
      void s.prompt(next.message, next.blocks, next.label);
    } finally {
      handing.delete(s);
    }
  };
  const renderQueue = () => {
    const waiting = session ? queueOf(session) : [];
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
              onclick: () => {
                waiting.splice(i, 1);
                renderQueue();
              },
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
    if (/^\/new\s*$/.test(text)) {
      input.value = '';
      state.draft = '';
      newChat.click();
      return;
    }
    if (!session || session.status === 'closed' || session.status === 'error') {
      session = deps.startSession(agentId);
      attach(agentId, false);
    }
    const note = includeNote ? deps.currentNote() : undefined;
    const atts = [...(note ? [note] : []), ...state.attachments];
    const s = session;
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
    if (!watched.has(s)) {
      watched.add(s);
      // Also covers the first message, which waits for the agent to start.
      s.onDidChange(() => flush(s));
    }
    if (interrupt && s.status === 'working') {
      queueOf(s).unshift(item);
      s.cancel();
    } else queueOf(s).push(item);
    renderQueue();
    flush(s);
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
    // Works with every agent: handled here, not sent.
    { name: 'new', description: 'Start a new chat with this agent' },
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
    const config = deps.agents().find((a) => a.id === agentId);
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
    agentPill.set(
      deps.agents().map((a) => ({ id: a.id, name: a.name })),
      agentId,
      selectAgent,
    );
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
  // The built-in assistant has nothing to launch: show its state (or the sign-in) right away.
  const builtIn = (id: string) => deps.agents().find((a) => a.id === id)?.kind === 'chatgpt';
  attach(agentId, builtIn(agentId));

  return {
    focus() {
      input.focus();
    },
    dispose() {
      state.listeners.delete(onState);
      activeSub.dispose();
      sub?.dispose();
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onSelectionGone);
      hideQuoteButton();
    },
  };
}
