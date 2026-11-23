import { EditorView } from '@codemirror/view';
import { CodeMirror, Vim } from '@replit/codemirror-vim';
import { yUndoManagerKeymap } from 'y-codemirror.next';
import { startLeap } from './leap';
import { DELIMITERS, delimitedIn } from './objects';

/**
 * What the vim keys do beyond editing one note: the commands and keys that reach into the app
 * (other files, the search, the tabs). The bindings are the same for every editor, so they are
 * set up once and set up anew when an extra is switched on or off.
 */

/** The extras that can be switched on and off. */
export interface VimExtras {
  /** `<Space>ff`, `gt`/`gT`, `:e`, `:bn`…: other files and tabs. */
  files: boolean;
  /** `<Space>fg`, `:grep`: search in all files. */
  search: boolean;
  /** `s` / `S` and two characters: leap to a place further down / further up on screen. */
  leap: boolean;
  /** Yanked text goes to the system's clipboard, and what was copied elsewhere is pasted. */
  clipboard: boolean;
  /** `:` in normal mode opens the app's command palette instead of vim's command line. */
  palette: boolean;
  /** `<Space>c`: a comment on the selection, or on the word at the cursor. */
  comment: boolean;
  /** `jk` typed quickly leaves insert mode. */
  jk: boolean;
  /** `j` and `k` move by the lines as they are on screen (a wrapped paragraph is several). */
  wrapped: boolean;
}

/** What the keys ask of the app. */
export interface VimActions {
  command(id: string, args?: unknown): void;
  /** Opens a note by its name or path (`:e name`). False if there is none. */
  open(name: string): boolean;
  save(): void;
  notify(text: string): void;
}

type Cm = { cm6: EditorView };
const viewOf = (cm: unknown): EditorView => (cm as Cm).cm6;

/** The keys of each extra, to take them back when it is switched off. */
const KEYS: Array<{ extra: keyof VimExtras; keys: string; context: string; action: string }> = [
  { extra: 'files', keys: '<Space>ff', context: 'normal', action: 'pumiceSwitcher' },
  { extra: 'files', keys: '<Space>b', context: 'normal', action: 'pumiceSwitcher' },
  { extra: 'files', keys: '<Space>p', context: 'normal', action: 'pumicePalette' },
  { extra: 'palette', keys: ':', context: 'normal', action: 'pumicePalette' },
  { extra: 'comment', keys: '<Space>c', context: 'normal', action: 'pumiceComment' },
  { extra: 'comment', keys: '<Space>c', context: 'visual', action: 'pumiceComment' },
  { extra: 'files', keys: '<Space>h', context: 'normal', action: 'pumiceBack' },
  { extra: 'files', keys: '<Space>l', context: 'normal', action: 'pumiceForward' },
  { extra: 'files', keys: '<Space>q', context: 'normal', action: 'pumiceCloseTab' },
  { extra: 'files', keys: 'gt', context: 'normal', action: 'pumiceNextTab' },
  { extra: 'files', keys: 'gT', context: 'normal', action: 'pumicePreviousTab' },
  { extra: 'search', keys: '<Space>fg', context: 'normal', action: 'pumiceFind' },
  { extra: 'search', keys: '<Space>/', context: 'normal', action: 'pumiceSearch' },
  { extra: 'leap', keys: 's', context: 'normal', action: 'pumiceLeap' },
  { extra: 'leap', keys: 'S', context: 'normal', action: 'pumiceLeapBack' },
];

let defined = false;
/** Whether Space was taken from its own meaning (moving right) to lead other keys. */
let spaceFreed = false;
let mapped: Array<{ keys: string; context: string }> = [];
let actions: VimActions | undefined;

function define(): void {
  if (defined) return;
  defined = true;
  // `u` and Ctrl-r: the editor keeps its history with the note's shared state (so that it
  // also holds across devices), not in the place the vim keys look for it.
  const history = (key: string) => (cm: unknown) => {
    yUndoManagerKeymap.find((k) => k.key === key)?.run?.(viewOf(cm));
  };
  // Scrolling: the note scrolls in its page, not in the editor itself, which is where the vim
  // keys look. They are pointed at what really scrolls (Ctrl-d, Ctrl-u, Ctrl-f, Ctrl-b, …).
  const scrollerOf = (cm: unknown): HTMLElement => {
    const view = viewOf(cm);
    for (let el: HTMLElement | null = view.scrollDOM; el; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight)
        return el;
    }
    return view.scrollDOM;
  };
  const adapter = CodeMirror.prototype as unknown as {
    getScrollInfo(this: unknown): Record<string, number>;
    scrollTo(this: unknown, x?: number | null, y?: number | null): void;
  };
  adapter.getScrollInfo = function () {
    const el = scrollerOf(this);
    return {
      left: el.scrollLeft,
      top: el.scrollTop,
      height: el.scrollHeight,
      width: el.scrollWidth,
      clientHeight: el.clientHeight,
      clientWidth: el.clientWidth,
    };
  };
  adapter.scrollTo = function (x, y) {
    const el = scrollerOf(this);
    if (x !== null && x !== undefined) el.scrollLeft = x;
    if (y !== null && y !== undefined) el.scrollTop = y;
  };
  // zz, zt, zb (and z., z<CR>, z-): the cursor's line to the middle, top or bottom.
  Vim.defineAction('scrollToCursor', (cm, args) => {
    const view = viewOf(cm);
    const position = (args as { position?: string }).position;
    const y = position === 'top' ? 'start' : position === 'bottom' ? 'end' : 'center';
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.selection.main.head, { y, yMargin: 24 }),
    });
  });
  const commands = CodeMirror.commands as unknown as Record<string, (cm: unknown) => void>;
  commands.undo = history('Mod-z');
  commands.redo = history('Mod-y');
  const run = (id: string) => () => actions?.command(id);
  // A comment on what is selected (visual mode), else on the word at the cursor.
  Vim.defineAction('pumiceComment', (cm) => {
    const view = viewOf(cm);
    const { from, to } = view.state.selection.main;
    const visual = (cm as unknown as { state: { vim?: { visualMode?: boolean } } }).state.vim
      ?.visualMode;
    if (visual) Vim.exitVisualMode(cm as never);
    actions?.command('comments.add', visual ? { from, to } : undefined);
  });
  Vim.defineAction('pumiceSwitcher', run('switcher.open'));
  Vim.defineAction('pumicePalette', run('palette.open'));
  Vim.defineAction('pumiceBack', run('workspace.back'));
  Vim.defineAction('pumiceForward', run('workspace.forward'));
  Vim.defineAction('pumiceCloseTab', run('workspace.close-tab'));
  Vim.defineAction('pumiceNextTab', run('workspace.next-tab'));
  Vim.defineAction('pumicePreviousTab', run('workspace.previous-tab'));
  Vim.defineAction('pumiceSearch', run('search.open'));
  Vim.defineAction('pumiceFind', run('search.find'));
  // To the end of the line and into insert mode, then Enter as the editor has it (it goes on
  // with a list, a quote, the indentation).
  Vim.defineAction('pumiceOpenBelow', (cm) => {
    const view = viewOf(cm);
    Vim.handleKey(cm as never, 'A', 'mapping');
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  Vim.defineAction('pumiceLeap', (cm) => startLeap(viewOf(cm), 1));
  Vim.defineAction('pumiceLeapBack', (cm) => startLeap(viewOf(cm), -1));

  // Commands after `:`. Notes are saved as they are written, so `:w` only says so.
  Vim.defineEx('write', 'w', () => {
    actions?.save();
    actions?.notify('Saved');
  });
  Vim.defineEx('quit', 'q', run('workspace.close-tab'));
  Vim.defineEx('wq', 'wq', () => {
    actions?.save();
    actions?.command('workspace.close-tab');
  });
  Vim.defineEx('xit', 'x', () => {
    actions?.save();
    actions?.command('workspace.close-tab');
  });
  Vim.defineEx('edit', 'e', (_cm, params) => {
    const name = (params.argString ?? '').trim();
    if (!name) return actions?.command('switcher.open');
    if (!actions?.open(name)) actions?.notify(`No note called “${name}”.`);
  });
  Vim.defineEx('bnext', 'bn', run('workspace.next-tab'));
  Vim.defineEx('bprevious', 'bp', run('workspace.previous-tab'));
  Vim.defineEx('tabnext', 'tabn', run('workspace.next-tab'));
  Vim.defineEx('tabprevious', 'tabp', run('workspace.previous-tab'));
  Vim.defineEx('bdelete', 'bd', run('workspace.close-tab'));
  Vim.defineEx('grep', 'gr', run('search.find'));
  Vim.defineEx('files', 'files', run('switcher.open'));
}

/** Sets the keys of the extras that are on (and takes back those of the ones that are off). */
export function configureVim(extras: VimExtras, appActions: VimActions): void {
  actions = appActions;
  define();
  for (const { keys, context } of mapped) {
    try {
      Vim.unmap(keys, context);
    } catch {
      // Was not mapped after all.
    }
  }
  mapped = [];
  // The leader is Space, which in normal mode otherwise only moves right: with keys behind
  // the leader it no longer does (it would move before the second key is typed).
  const leader = KEYS.some((k) => k.keys.startsWith('<Space>') && extras[k.extra]);
  // (Its own mapping is for all modes: it is found without a mode, not under "normal".)
  const everywhere = undefined as unknown as string;
  if (leader && !spaceFreed) {
    Vim.unmap('<Space>', everywhere);
    spaceFreed = true;
  } else if (!leader && spaceFreed) {
    Vim.noremap('<Space>', 'l', everywhere);
    spaceFreed = false;
  }
  for (const { extra, keys, context, action } of KEYS) {
    if (!extras[extra]) continue;
    Vim.mapCommand(keys, 'action', action, {}, { context });
    mapped.push({ keys, context });
  }
  if (extras.jk) {
    Vim.map('jk', '<Esc>', 'insert');
    mapped.push({ keys: 'jk', context: 'insert' });
  }
  // i$ a$ and the like: what stands between the same marks (see `objects`).
  Vim.defineMotion('pumiceDelimited', (cm, head, args) => {
    const view = viewOf(cm);
    const { doc } = view.state;
    const at = doc.line(head.line + 1).from + head.ch;
    const mark = (args as unknown as { mark: string }).mark;
    const span = delimitedIn(
      doc.toString(),
      mark,
      at,
      !!(args as unknown as { inner?: boolean }).inner,
    );
    if (!span) return null as never;
    const pos = (offset: number) => {
      const line = doc.lineAt(offset);
      return new CodeMirror.Pos(line.number - 1, offset - line.from);
    };
    // In visual mode the selection ends on its last character.
    const visual = (cm as unknown as { state: { vim?: { visualMode?: boolean } } }).state.vim
      ?.visualMode;
    return [pos(span.from), pos(visual ? Math.max(span.from, span.to - 1) : span.to)] as never;
  });
  for (const mark of DELIMITERS)
    for (const inner of [true, false]) {
      const keys = `${inner ? 'i' : 'a'}${mark}`;
      Vim.mapCommand(keys, 'motion', 'pumiceDelimited', { mark, inner } as never, {});
      mapped.push({ keys, context: undefined as never });
    }
  // `o` on a list item goes on with the list, as Enter at the end of the item does.
  Vim.mapCommand('o', 'action', 'pumiceOpenBelow', {}, { context: 'normal' });
  mapped.push({ keys: 'o', context: 'normal' });
  if (extras.wrapped) {
    // A paragraph is one line of the note but several on screen: up and down go by what is
    // seen (vim's gj and gk), in normal and in visual mode.
    for (const context of ['normal', 'visual'])
      for (const [keys, to] of [
        ['j', 'gj'],
        ['k', 'gk'],
        ['<Down>', 'gj'],
        ['<Up>', 'gk'],
      ] as const) {
        Vim.noremap(keys, to, context);
        mapped.push({ keys, context });
      }
  }
  clipboard = extras.clipboard;
}

// ---- the system's clipboard ---------------------------------------------------------------

let clipboard = false;
/** What the unnamed register and the clipboard last agreed on. */
let agreed = '';

interface Register {
  toString(): string;
  setText(text: string, linewise?: boolean, blockwise?: boolean): void;
  linewise?: boolean;
}
const unnamed = (): Register | undefined =>
  (
    Vim as unknown as {
      getRegisterController?: () => { unnamedRegister: Register };
    }
  ).getRegisterController?.().unnamedRegister;

/** After a vim command: what was yanked or deleted goes to the system's clipboard. */
export function yankToClipboard(): void {
  if (!clipboard) return;
  const text = unnamed()?.toString() ?? '';
  if (!text || text === agreed) return;
  agreed = text;
  void navigator.clipboard
    ?.writeText(text)
    .catch((e: unknown) => console.warn('[pumice] vim: could not copy to the clipboard', e));
}

/** When the editor is come back to: what was copied elsewhere is what `p` puts. */
export function clipboardToRegister(): void {
  if (!clipboard) return;
  void navigator.clipboard
    ?.readText()
    .then((text) => {
      if (!text || text === agreed) return;
      agreed = text;
      // A copy that ends in a line break is put as lines, as vim does with a yanked line.
      unnamed()?.setText(text, text.endsWith('\n'));
    })
    .catch((e: unknown) => console.warn('[pumice] vim: could not read the clipboard', e));
}
