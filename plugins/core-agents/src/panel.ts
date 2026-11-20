import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import type { MarkdownSyntaxApi, VaultPath, WorkspaceApi } from '@pumice/api';
import { button, createIcon, h } from '@pumice/ui';
import { vaultPathOf, type AgentConfig, type AgentSession, type TranscriptItem } from './session';

/** Text attached to the next prompt (a selection, a comment thread, the current note). */
export interface Attachment {
  label: string;
  blocks: ContentBlock[];
}

export interface AgentPanelDeps {
  workspace: WorkspaceApi;
  syntax: MarkdownSyntaxApi;
  agents(): AgentConfig[];
  /** Null on platforms that can't run programs. */
  available: boolean;
  root: string;
  sessionFor(agentId: string): AgentSession | undefined;
  startSession(agentId: string): AgentSession;
  currentAgent(): string;
  setCurrentAgent(id: string): void;
  /** Attachment for the active note (offered by default). */
  currentNote(): Attachment | undefined;
}

/** State shared between commands ("Ask agent about selection") and the panel. */
export class AgentPanelState {
  attachments: Attachment[] = [];
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
        'Agents run in the desktop app: it starts Claude Code, Codex or Gemini CLI on your computer, signed in with your own account.',
      ),
    );
    return { dispose() {} };
  }

  const picker = h('select', { class: 'pm-select pm-agent-picker', 'aria-label': 'Agent' });
  const modePicker = h('select', {
    class: 'pm-select pm-agent-mode',
    'aria-label': 'Mode',
    hidden: true,
  });
  const status = h('span', { class: 'pm-agent-status' });
  const newChat = h(
    'button',
    { class: 'pm-icon-button', title: 'New chat', 'aria-label': 'New chat' },
    createIcon('plus', 15),
  );
  const transcript = h('div', { class: 'pm-panel-scroll pm-agent-transcript', role: 'log' });
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
    h('div', { class: 'pm-panel-toolbar pm-agent-toolbar' }, picker, modePicker, status, newChat),
    transcript,
    h(
      'div',
      { class: 'pm-agent-composer' },
      chips,
      input,
      h('div', { class: 'pm-agent-composer-actions' }, stop, send),
    ),
  );

  let session: AgentSession | undefined;
  let sub: { dispose(): void } | undefined;
  let includeNote = true;

  const attach = (agentId: string, start: boolean) => {
    sub?.dispose();
    session = deps.sessionFor(agentId) ?? (start ? deps.startSession(agentId) : undefined);
    sub = session?.onDidChange(() => scheduleRender());
    render();
  };

  const fillPicker = () => {
    picker.replaceChildren(
      ...deps
        .agents()
        .map((a) => h('option', { value: a.id, selected: a.id === deps.currentAgent() }, a.name)),
    );
  };
  picker.addEventListener('change', () => {
    deps.setCurrentAgent(picker.value);
    attach(picker.value, false);
  });
  modePicker.addEventListener('change', () => void session?.setMode(modePicker.value));
  newChat.addEventListener('click', () => {
    session?.dispose();
    session = deps.startSession(picker.value);
    attach(picker.value, false);
  });

  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    if (!session || session.status === 'closed' || session.status === 'error') {
      session = deps.startSession(picker.value);
      attach(picker.value, false);
    }
    const note = includeNote ? deps.currentNote() : undefined;
    const atts = [...(note ? [note] : []), ...state.attachments];
    const s = session;
    input.value = '';
    state.draft = '';
    state.attachments = [];
    renderChips();
    const go = () =>
      void s.prompt(
        text,
        atts.flatMap((a) => a.blocks),
        atts.map((a) => a.label).join(', ') || undefined,
      );
    // The first prompt waits for the agent to start.
    if (s.status === 'starting') {
      const wait = s.onDidChange(() => {
        if (s.status === 'starting') return;
        wait.dispose();
        if (s.status === 'ready') go();
      });
    } else go();
  };
  send.addEventListener('click', submit);
  stop.addEventListener('click', () => session?.cancel());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => (state.draft = input.value));

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
          h('div', { class: 'pm-agent-msg-text' }, it.text),
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
    const config = deps.agents().find((a) => a.id === picker.value);
    status.textContent = session
      ? {
          starting: 'Starting…',
          ready: 'Ready',
          working: 'Working…',
          closed: 'Stopped',
          error: 'Error',
        }[session.status]
      : '';
    status.dataset.status = session?.status ?? '';
    stop.hidden = session?.status !== 'working';
    send.disabled = session?.status === 'working';
    modePicker.hidden = !session?.modes.length;
    if (session?.modes.length) {
      modePicker.replaceChildren(
        ...session.modes.map((m) =>
          h('option', { value: m.id, selected: m.id === session!.currentMode }, m.name),
        ),
      );
    }
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

  fillPicker();
  input.value = state.draft;
  renderChips();
  attach(picker.value || deps.currentAgent(), false);

  return {
    focus() {
      input.focus();
    },
    dispose() {
      state.listeners.delete(onState);
      activeSub.dispose();
      sub?.dispose();
      cancelAnimationFrame(frame);
    },
  };
}
