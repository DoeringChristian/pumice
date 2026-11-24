import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import { revealUnfocused } from '@pumice/api';
import { createIcon } from '@pumice/ui';

/**
 * Find and replace in a note: a small card at the top right of the note, in place of the
 * library's bar across the whole editor.
 */

/** Matches are counted up to here; a note with more shows "999+". */
const MOST = 999;

function iconButton(icon: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pm-find-button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.append(createIcon(icon, 14));
  // The field keeps the focus.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', run);
  return button;
}

function textButton(text: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pm-find-action';
  button.textContent = text;
  button.title = title;
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', run);
  return button;
}

/** How many matches there are, and which of them is selected (1-based, 0 if none is). */
function countMatches(state: EditorState, query: SearchQuery): { total: number; at: number } {
  if (!query.search || !query.valid) return { total: 0, at: 0 };
  const { from, to } = state.selection.main;
  let total = 0;
  let at = 0;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === from && next.value.to === to) at = total;
    if (total > MOST) break;
  }
  return { total, at };
}

/** The first match at or behind the cursor, or else the first of the note. */
function firstMatch(state: EditorState, query: SearchQuery): { from: number; to: number } | null {
  if (!query.search || !query.valid) return null;
  const from = state.selection.main.from;
  const behind = query.getCursor(state, from).next();
  if (!behind.done) return behind.value;
  const first = query.getCursor(state).next();
  return first.done ? null : first.value;
}

function createPanel(view: EditorView): Panel {
  let query = getSearchQuery(view.state);

  const dom = document.createElement('div');
  dom.className = 'pm-find';
  dom.setAttribute('role', 'search');

  const field = (placeholder: string, value: string): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pm-find-input';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = value;
    return input;
  };
  const find = field('Find', query.search);
  // The library puts the focus here when the panel opens.
  find.setAttribute('main-field', 'true');
  const replace = field('Replace', query.replace);

  const flags = {
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp,
  };
  const commit = () => {
    const next = new SearchQuery({ search: find.value, replace: replace.value, ...flags });
    if (next.eq(query)) return;
    query = next;
    // What is typed is found at once: the first match from where the cursor is.
    const match = firstMatch(view.state, next);
    view.dispatch({
      effects: [
        setSearchQuery.of(next),
        ...(match ? [EditorView.scrollIntoView(match.from, { y: 'nearest' })] : []),
      ],
      ...(match ? { selection: { anchor: match.from, head: match.to } } : {}),
    });
    showCount();
  };
  const toggle = (label: string, title: string, key: keyof typeof flags): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pm-find-toggle';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('aria-pressed', String(flags[key]));
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      flags[key] = !flags[key];
      button.setAttribute('aria-pressed', String(flags[key]));
      commit();
    });
    return button;
  };
  const toggles = {
    caseSensitive: toggle('Aa', 'Match case', 'caseSensitive'),
    wholeWord: toggle('ab', 'Whole words', 'wholeWord'),
    regexp: toggle('.*', 'Regular expression', 'regexp'),
  };

  const count = document.createElement('span');
  count.className = 'pm-find-count';
  count.setAttribute('aria-live', 'polite');

  const box = document.createElement('div');
  box.className = 'pm-find-box';
  box.append(find, toggles.caseSensitive, toggles.wholeWord, toggles.regexp);

  const expand = iconButton('chevron-right', 'Replace', () => setReplacing(!replacing));
  expand.classList.add('pm-find-expand');
  const findRow = document.createElement('div');
  findRow.className = 'pm-find-row';
  findRow.append(
    expand,
    box,
    count,
    iconButton('arrow-up', 'Previous (Shift+Enter)', () => findPrevious(view)),
    iconButton('arrow-down', 'Next (Enter)', () => findNext(view)),
    iconButton('x', 'Close (Esc)', () => closeSearchPanel(view)),
  );

  const replaceBox = document.createElement('div');
  replaceBox.className = 'pm-find-box';
  replaceBox.append(replace);
  const replaceRow = document.createElement('div');
  replaceRow.className = 'pm-find-row pm-find-replace';
  replaceRow.append(
    replaceBox,
    textButton('Replace', 'Replace this one (Enter)', () => replaceNext(view)),
    textButton('All', 'Replace all', () => replaceAll(view)),
  );
  dom.append(findRow, replaceRow);

  let replacing = !!query.replace;
  const setReplacing = (on: boolean) => {
    replacing = on && !view.state.readOnly;
    dom.classList.toggle('is-replacing', replacing);
    expand.classList.toggle('is-open', replacing);
    expand.hidden = view.state.readOnly;
    if (replacing && dom.isConnected) replace.focus();
  };

  function showCount(): void {
    const { total, at } = countMatches(view.state, query);
    const none = !!query.search && (!query.valid || !total);
    box.classList.toggle('is-missing', none);
    count.textContent = !query.search
      ? ''
      : !query.valid
        ? 'Invalid'
        : !total
          ? 'No results'
          : `${at || '?'} of ${total > MOST ? `${MOST}+` : total}`;
  }

  find.addEventListener('input', commit);
  replace.addEventListener('input', commit);
  dom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === 'Enter' && e.target === find) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === 'Enter' && e.target === replace) {
      e.preventDefault();
      (e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(view);
    } else if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      setReplacing(true);
    } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyG') {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    }
  });

  setReplacing(replacing);
  showCount();

  return {
    dom,
    top: true,
    mount() {
      find.select();
    },
    update(update: ViewUpdate) {
      const now = getSearchQuery(update.state);
      const changed = !now.eq(query);
      if (changed) {
        // Set from elsewhere (the selection that the panel was opened with, another command).
        query = now;
        if (find.value !== now.search) find.value = now.search;
        if (replace.value !== now.replace) replace.value = now.replace;
        for (const key of ['caseSensitive', 'wholeWord', 'regexp'] as const) {
          flags[key] = now[key];
          toggles[key].setAttribute('aria-pressed', String(now[key]));
        }
      }
      if (update.startState.readOnly !== update.state.readOnly) setReplacing(replacing);
      if (changed || update.docChanged || update.selectionSet) showCount();
    },
  };
}

/** Find and replace, as a card of the app's own. */
export function findAndReplace(): Extension {
  return [
    search({ top: true, createPanel }),
    // A match in what is drawn (a formula, a link) shows as the source it was found in.
    revealUnfocused.of(searchPanelOpen),
    // What is found is not scrolled to under the card, nor to the very edge of the window.
    EditorView.scrollMargins.of((view) =>
      searchPanelOpen(view.state) ? { top: 96, bottom: 72 } : null,
    ),
  ];
}
