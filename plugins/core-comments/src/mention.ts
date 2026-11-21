import type { AgentMention } from '@pumice/api';

/** The `@…` being typed right before the cursor: where it starts and what was typed of it. */
export function mentionBefore(
  text: string,
  cursor: number,
): { from: number; typed: string } | undefined {
  const m = /(?:^|[\s(])@([\w-]*)$/.exec(text.slice(0, cursor));
  return m ? { from: cursor - m[1]!.length - 1, typed: m[1]!.toLowerCase() } : undefined;
}

/** Who fits what was typed: names that start with it first, then names that contain it. */
export function matchMentions(all: AgentMention[], typed: string): AgentMention[] {
  const seen = new Set<string>();
  const unique = all.filter((m) => !seen.has(m.mention) && !!seen.add(m.mention));
  const starts = unique.filter((m) => m.mention.startsWith(typed));
  const contains = unique.filter(
    (m) =>
      !m.mention.startsWith(typed) &&
      (m.mention.includes(typed) || m.label.toLowerCase().includes(typed)),
  );
  return [...starts, ...contains].slice(0, 8);
}

/**
 * Offers the chats and agents that can be addressed while `@…` is typed in a comment box.
 * The list sits right under the box; arrows choose, Enter or Tab takes one, Escape closes it.
 */
export function attachMentionCompletion(
  input: HTMLTextAreaElement,
  mentions: () => AgentMention[],
): HTMLElement {
  const list = document.createElement('div');
  list.className = 'pm-comment-mentions';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  let shown: AgentMention[] = [];
  let selected = 0;
  let from = 0;

  const close = () => {
    shown = [];
    list.hidden = true;
  };
  const take = (m: AgentMention) => {
    const cursor = input.selectionStart;
    const rest = input.value.slice(cursor);
    const insert = `@${m.mention}${rest.startsWith(' ') ? '' : ' '}`;
    input.value = input.value.slice(0, from) + insert + rest;
    const at = from + insert.length + (rest.startsWith(' ') ? 1 : 0);
    input.setSelectionRange(at, at);
    close();
    // Whoever listens for typing (the size of the box, who it goes to) hears of it.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  const render = () => {
    list.hidden = shown.length === 0;
    list.replaceChildren(
      ...shown.map((m, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `pm-comment-mention${i === selected ? ' is-selected' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === selected));
        const name = document.createElement('span');
        name.className = 'pm-comment-mention-name';
        name.textContent = `@${m.mention}`;
        const detail = document.createElement('span');
        detail.className = 'pm-comment-mention-detail';
        detail.textContent = m.detail ? `${m.label} · ${m.detail}` : m.label;
        row.append(name, detail);
        // mousedown: the box keeps the focus.
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          take(m);
        });
        return row;
      }),
    );
  };
  const update = () => {
    const typing =
      input.selectionStart === input.selectionEnd
        ? mentionBefore(input.value, input.selectionStart)
        : undefined;
    if (!typing) return close();
    from = typing.from;
    shown = matchMentions(mentions(), typing.typed);
    // Typed out in full: nothing left to offer.
    if (shown.length === 1 && shown[0]!.mention === typing.typed) shown = [];
    if (selected >= shown.length) selected = 0;
    render();
  };

  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', close);
  // Before the box's own keys: Enter takes a name here instead of sending the comment.
  input.addEventListener(
    'keydown',
    (e) => {
      if (!shown.length || e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        selected = (selected + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        render();
      } else if (e.key === 'Enter' || e.key === 'Tab') take(shown[selected]!);
      else if (e.key === 'Escape') close();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  return list;
}
