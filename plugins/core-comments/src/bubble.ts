import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import type { AgentMention, EditorExtensionContext, VaultPath } from '@pumice/api';
import { createIcon } from '@pumice/ui';
import { attachMentionCompletion } from './mention';

/**
 * Commenting where the text is: selecting text shows a small comment button next to it, and
 * the comment is written in a box right there (docs/plan/09). `@agent` in the comment hands it
 * to the assistant.
 */

export interface BubbleDeps {
  /** Comment mode: selecting text opens the comment box right away. */
  commentMode(): boolean;
  /** Whether comments can be sent to an agent (shows the hint and the shortcut button). */
  agentAvailable(): boolean;
  /** The chats and agents a comment can address with `@…`. */
  mentions(): AgentMention[];
  /** The chat that would answer a comment with this text on `range` (undefined: nobody). */
  recipient(
    path: VaultPath,
    range: { from: number; to: number },
    body: string,
  ): Promise<string | undefined>;
  submit(path: VaultPath, range: { from: number; to: number }, body: string): Promise<void>;
  /** Keeps what was written when the box is left without sending it. */
  saveDraft(path: VaultPath, range: { from: number; to: number }, body: string): Promise<void>;
}

/** Opens the comment box for a range (null closes it). */
/** A range the comment box is open for; `above`: the box stands over its end, not under it. */
export interface ComposerRange {
  from: number;
  to: number;
  above?: boolean;
}

export const openComposer = StateEffect.define<ComposerRange | null>();
const setDragging = StateEffect.define<boolean>();

interface BubbleState {
  composer: ComposerRange | null;
  /** A mouse selection is in progress: the button waits until it ends. */
  dragging: boolean;
}

const bubbleField = StateField.define<BubbleState>({
  create: () => ({ composer: null, dragging: false }),
  update(value, tr) {
    let { composer, dragging } = value;
    if (composer && tr.docChanged) {
      composer = {
        ...composer,
        from: tr.changes.mapPos(composer.from, 1),
        to: tr.changes.mapPos(composer.to, -1),
      };
      if (composer.to < composer.from) composer = null;
    }
    for (const e of tr.effects) {
      if (e.is(openComposer)) composer = e.value;
      if (e.is(setDragging)) dragging = e.value;
    }
    return composer === value.composer && dragging === value.dragging
      ? value
      : { composer, dragging };
  },
});

function composerDom(
  view: EditorView,
  range: ComposerRange,
  deps: BubbleDeps,
  path: () => VaultPath | undefined,
): HTMLElement {
  const box = document.createElement('div');
  // Over a picture's corner it reaches back over the picture, to stand at its comment button.
  box.className = `pm-comment-popover${range.above ? ' is-over-media' : ''}`;
  const input = document.createElement('textarea');
  input.className = 'pm-comment-input';
  input.rows = 2;
  input.placeholder = deps.agentAvailable() ? 'Comment… (@agent asks the assistant)' : 'Comment…';
  input.setAttribute('aria-label', 'Comment');
  const close = () => {
    view.dispatch({ effects: openComposer.of(null) });
    view.focus();
  };
  const error = document.createElement('div');
  error.className = 'pm-comment-error';
  const send = async () => {
    const body = input.value.trim();
    const p = path();
    if (!body || p === undefined) return;
    input.disabled = true;
    try {
      // The range as it is now (the note may have changed while the box was open).
      const current = view.state.field(bubbleField).composer ?? range;
      await deps.submit(p, current, body);
      close();
    } catch (e) {
      input.disabled = false;
      error.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  input.addEventListener('keydown', (e) => {
    // Keep the editor's shortcuts out of the comment box.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  const actions = document.createElement('div');
  actions.className = 'pm-comment-popover-actions';
  const mentionsAgent = () => /(^|\s)@agent\b/i.test(input.value);
  const to = document.createElement('div');
  to.className = 'pm-comment-recipient';
  to.hidden = true;
  let asked = 0;
  const showRecipient = () => {
    const mine = ++asked;
    const p = path();
    const current = view.state.field(bubbleField).composer ?? range;
    void (p === undefined ? Promise.resolve(undefined) : deps.recipient(p, current, input.value))
      .catch(() => undefined)
      .then((name) => {
        if (mine !== asked) return;
        to.hidden = !name;
        to.replaceChildren(...(name ? [createIcon('bot', 12), ` Goes to ${name}`] : []));
      });
  };
  let ask: HTMLButtonElement | undefined;
  if (deps.agentAvailable()) {
    ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'pm-comment-ask';
    ask.title = 'Send this comment to the assistant';
    ask.append(createIcon('bot', 13), ' @agent');
    ask.addEventListener('mousedown', (e) => e.preventDefault());
    ask.addEventListener('click', () => {
      input.value = mentionsAgent()
        ? input.value.replace(/(^|\s)@agent\b\s?/i, '$1')
        : `@agent ${input.value}`;
      sync();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    actions.append(ask);
  }
  const hint = document.createElement('span');
  hint.className = 'pm-comment-popover-hint';
  hint.textContent = 'Enter to comment · Esc to cancel';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'pm-comment-send';
  ok.title = 'Comment (Enter)';
  ok.setAttribute('aria-label', 'Comment');
  ok.append(createIcon('send', 14));
  ok.addEventListener('click', () => void send());
  actions.append(hint, ok);
  /** Grows the field with its text and reflects what is typed in the controls. */
  const sync = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, input.scrollHeight)}px`;
    ok.disabled = !input.value.trim();
    ask?.classList.toggle('is-on', mentionsAgent());
    showRecipient();
  };
  input.addEventListener('input', sync);
  input.placeholder = 'Add a comment…';
  requestAnimationFrame(sync);
  box.append(input, attachMentionCompletion(input, deps.mentions), to, error, actions);
  // A click elsewhere closes the box; what was written is kept as a draft, not sent.
  const outside = (e: MouseEvent) => {
    if (!box.isConnected) return document.removeEventListener('mousedown', outside, true);
    if (box.contains(e.target as Node)) return;
    document.removeEventListener('mousedown', outside, true);
    const body = input.value.trim();
    const p = path();
    const current = view.state.field(bubbleField).composer ?? range;
    if (body && p !== undefined && !input.disabled) void deps.saveDraft(p, current, body);
    // The click goes where it was aimed: the box only goes away.
    view.dispatch({ effects: openComposer.of(null) });
  };
  requestAnimationFrame(() => document.addEventListener('mousedown', outside, true));
  // The tooltip is added after this returns.
  requestAnimationFrame(() => input.focus());
  return box;
}

function tooltips(
  state: EditorState,
  deps: BubbleDeps,
  path: () => VaultPath | undefined,
): readonly Tooltip[] {
  const { composer, dragging } = state.field(bubbleField);
  if (composer) {
    return [
      {
        pos: composer.to,
        // For a picture or video: over its top right corner, where its comment button is
        // (under its end is the far corner of the picture).
        above: !!composer.above,
        arrow: false,
        create: (view) => ({ dom: composerDom(view, composer, deps, path) }),
      },
    ];
  }
  const sel = state.selection.main;
  if (sel.empty || dragging || path() === undefined) return [];
  return [
    {
      pos: sel.head,
      above: sel.head < sel.anchor,
      arrow: false,
      create: (view) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pm-comment-bubble';
        button.title = 'Comment on the selection';
        button.setAttribute('aria-label', 'Comment on the selection');
        button.append(createIcon('message-square-plus', 15));
        // mousedown: act before the editor sees the click and drops the selection.
        button.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const s = view.state.selection.main;
          view.dispatch({ effects: openComposer.of({ from: s.from, to: s.to }) });
        });
        return { dom: button };
      },
    },
  ];
}

const pending = Decoration.mark({ class: 'pm-comment-mark is-active' });
function markSet(from: number, to: number) {
  return Decoration.set([pending.range(from, to)]);
}

export function commentBubble(deps: BubbleDeps, ctx: EditorExtensionContext): Extension {
  const path = () => ctx.path();
  return [
    bubbleField,
    showTooltip.computeN([bubbleField, 'selection'], (state) => tooltips(state, deps, path)),
    EditorView.decorations.compute([bubbleField], (state) => {
      const c = state.field(bubbleField).composer;
      return c && c.to > c.from ? markSet(c.from, c.to) : Decoration.none;
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        view.dispatch({ effects: setDragging.of(true) });
        const done = () => {
          window.removeEventListener('mouseup', done, true);
          // After the editor has set the final selection.
          setTimeout(() => {
            const sel = view.state.selection.main;
            view.dispatch({
              effects: [
                setDragging.of(false),
                ...(deps.commentMode() && !sel.empty && !view.state.field(bubbleField).composer
                  ? [openComposer.of({ from: sel.from, to: sel.to })]
                  : []),
              ],
            });
          });
        };
        window.addEventListener('mouseup', done, true);
        return false;
      },
    }),
  ];
}
