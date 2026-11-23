import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import {
  Documents,
  Editor,
  MetadataIndex,
  SettingsUi,
  Workspace,
  definePlugin,
  type Disposable,
  type PluginModule,
} from '@pumice/api';
import { h, settingItem, toggle } from '@pumice/ui';
import { CodeMirror, getCM, vim } from '@replit/codemirror-vim';
import manifestJson from '../manifest.json';
import { leapExtension, leaping } from './leap';
import { listCursor } from './lists';
import { clipboardToRegister, configureVim, yankToClipboard, type VimExtras } from './setup';
import './vim.css';

export const manifest = manifestJson;

/** The mode as vim names it, with the keys of a command that is not finished yet. */
function modeText(view: EditorView): string {
  const state = (
    getCM(view) as unknown as {
      state?: {
        vim?: {
          insertMode?: boolean;
          visualMode?: boolean;
          visualLine?: boolean;
          visualBlock?: boolean;
          inputState?: { keyBuffer?: string[]; prefixRepeat?: string[]; operator?: string };
        };
      };
    } | null
  )?.state?.vim;
  if (!state) return '';
  const mode = state.insertMode
    ? 'INSERT'
    : state.visualMode
      ? state.visualBlock
        ? 'V-BLOCK'
        : state.visualLine
          ? 'V-LINE'
          : 'VISUAL'
      : 'NORMAL';
  const input = state.inputState;
  const keys = [...(input?.prefixRepeat ?? []), ...(input?.keyBuffer ?? [])].join('');
  return keys ? `${mode}  ${keys}` : mode;
}

/** In normal mode with no command begun (no count, operator or first key of several). */
function idle(view: EditorView): boolean {
  const state = (
    getCM(view) as unknown as {
      state?: {
        vim?: {
          insertMode?: boolean;
          visualMode?: boolean;
          inputState?: { keyBuffer?: unknown[]; operator?: unknown; prefixRepeat?: unknown[] };
        };
      };
    } | null
  )?.state?.vim;
  return (
    !!state &&
    !state.insertMode &&
    !state.visualMode &&
    !state.inputState?.keyBuffer?.length &&
    !state.inputState?.operator &&
    !state.inputState?.prefixRepeat?.length
  );
}
export { leapTargets } from './leap';

const EXTRAS: Array<{ key: keyof VimExtras; on: boolean; name: string; about: string }> = [
  {
    key: 'files',
    on: true,
    name: 'Files and tabs',
    about:
      'Space f f: find a file (switch to another note). Space b: the same. Space p: all commands. gt / gT: next and previous tab. Space h / Space l: back and forward. Space q: close the tab. Also :e [name], :bn, :bp, :bd.',
  },
  {
    key: 'palette',
    on: true,
    name: 'Colon opens the command palette',
    about:
      'In normal mode, : opens the palette with all of the app’s commands. Off: it opens vim’s own command line (:s, :g, :42, :noh, …). In visual mode : is always vim’s, as it works on the selection.',
  },
  {
    key: 'comment',
    on: true,
    name: 'Comments',
    about:
      'Space c starts a comment: on the selection in visual mode, on the word at the cursor in normal mode.',
  },
  {
    key: 'search',
    on: true,
    name: 'Search in all files',
    about:
      'Space f g (find, grep) or :grep opens a list of every line in the vault that matches what is typed; Space / opens the search in the sidebar.',
  },
  {
    key: 'leap',
    on: true,
    name: 'Leap',
    about:
      's and a character label every place after the cursor where it stands; the next character leaves the places where the two stand together, and the label of one takes the cursor there. S does the same for the places before the cursor (after leap.nvim). They take the place of vim’s s and S, which are cl and cc.',
  },
  {
    key: 'clipboard',
    on: true,
    name: 'System clipboard',
    about:
      'What is yanked or deleted goes to the system’s clipboard, and p puts what was copied elsewhere.',
  },
  {
    key: 'wrapped',
    on: true,
    name: 'Move by lines on screen',
    about:
      'j and k (and the arrow keys) go up and down by the lines as they are shown: a paragraph that wraps is several of them. Off: they go by the lines of the note, a whole paragraph at a time. (gj and gk do the other one either way.)',
  },
  {
    key: 'jk',
    on: false,
    name: 'jk leaves insert mode',
    about: 'Typing j and k quickly one after the other does what Escape does.',
  },
];

export const plugin = definePlugin({
  activate(ctx) {
    const editor = ctx.use(Editor);
    const workspace = ctx.use(Workspace);

    const extras = (): VimExtras =>
      Object.fromEntries(
        EXTRAS.map((e) => [e.key, ctx.settings.get(e.key, e.on)]),
      ) as unknown as VimExtras;

    const command = (id: string, args?: unknown) =>
      void ctx.commands
        .execute(id, args)
        .catch((e: unknown) =>
          workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' }),
        );
    const save = () => {
      const path = workspace.activeFile;
      const documents = ctx.tryUse(Documents);
      if (!path || !documents?.isOpen(path)) return;
      void documents.open(path).then(async (handle) => {
        await handle.save().catch(() => undefined);
        handle.dispose();
      });
    };

    const configure = () =>
      configureVim(extras(), {
        command,
        open: (name) => {
          const from = workspace.activeFile ?? '';
          const found = ctx.tryUse(MetadataIndex)?.resolve(name, from)?.file.path;
          if (!found) return false;
          void workspace.openFile(found);
          return true;
        },
        save,
        notify: (text) => workspace.notify(text, { timeout: 1500 }),
      });

    /** The vim keys for one editor, with what the extras need around them. */
    const extension = (context: { sourceMode(): boolean }): Extension => [
      listCursor(() => context.sourceMode()),
      // In front of the vim keys: while a leap is on, the keys are its own.
      leapExtension((view) => editor.captions(view)),
      // j and k (and the arrow keys) in normal mode go into the caption of a figure where
      // that is what lies there; in it the vim keys hold as well (see `field`).
      Prec.highest(
        EditorView.domEventHandlers({
          keydown(event, view) {
            if (event.metaKey || event.ctrlKey || event.altKey) return false;
            const dir =
              event.key === 'j' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'k' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
            if (!dir || !idle(view) || !editor.enterCaptionFrom(view, dir)) return false;
            event.preventDefault();
            return true;
          },
        }),
      ),
      // In front of every other key binding of the editor: in normal mode a key is a command.
      Prec.highest(vim()),
      // The mode, in the bar at the bottom of the window (not in the note).
      ViewPlugin.define((view) => {
        let cm: unknown;
        const show = () => {
          if (!view.hasFocus) return;
          shown = () => modeItem.setText([modeText(view), message].filter(Boolean).join('   '));
          shown();
        };
        // The vim keys are set up with the editor: asked for once it stands.
        queueMicrotask(() => {
          cm = getCM(view);
          if (!cm) return;
          for (const event of ['vim-mode-change', 'vim-keypress', 'vim-command-done'])
            CodeMirror.on(cm as never, event, show);
          show();
        });
        view.contentDOM.addEventListener('focus', show);
        return {
          update: show,
          destroy: () => {
            view.contentDOM.removeEventListener('focus', show);
            if (cm)
              for (const event of ['vim-mode-change', 'vim-keypress', 'vim-command-done'])
                CodeMirror.off(cm as never, event, show);
          },
        };
      }),
      // After whatever the keys did: what was yanked or deleted goes to the system's
      // clipboard; coming back to the editor, what was copied elsewhere is what `p` puts.
      ViewPlugin.define((view) => {
        const focus = () => clipboardToRegister();
        view.contentDOM.addEventListener('focus', focus);
        if (view.hasFocus) focus();
        return {
          update: () => yankToClipboard(),
          destroy: () => view.contentDOM.removeEventListener('focus', focus),
        };
      }),
      EditorView.editorAttributes.of({ class: 'pm-vim' }),
    ];

    const modeItem = workspace.addStatusBarItem(5);
    ctx.register(modeItem);
    // What vim has to say ("3 lines yanked", "E486: Pattern not found") stands beside the
    // mode for a moment, not in a line of its own under the note.
    let message = '';
    let shown = () => modeItem.setText(message);
    let fading: ReturnType<typeof setTimeout> | undefined;
    const adapter = CodeMirror.prototype as unknown as {
      openNotification(template: unknown, options?: { duration?: number }): () => void;
    };
    const ownNotification = adapter.openNotification;
    adapter.openNotification = (template, options) => {
      message = (template instanceof Node ? (template.textContent ?? '') : String(template ?? ''))
        .replace(/\s*\(set nopcre[^)]*\)/, '')
        .trim();
      const close = () => {
        clearTimeout(fading);
        message = '';
        shown();
      };
      clearTimeout(fading);
      shown();
      fading = setTimeout(close, options?.duration || 4000);
      return close;
    };
    ctx.register(() => {
      adapter.openNotification = ownNotification;
      clearTimeout(fading);
    });

    // What is typed after ":" in vim, in the palette (":" opens it): w, q, wq, wqa, …
    const exCommands: Disposable[] = [];
    const EX: Array<[string, string, () => void]> = [
      ['w', 'save', () => save()],
      ['q', 'close this tab', () => command('workspace.close-tab')],
      ['wq', 'save, close this tab', () => (save(), command('workspace.close-tab'))],
      ['x', 'save and close this tab', () => (save(), command('workspace.close-tab'))],
      ['wa', 'save all notes', () => save()],
      ['qa', 'close all the tabs', () => command('workspace.close-all-tabs')],
      ['wqa', 'save, close all tabs', () => (save(), command('workspace.close-all-tabs'))],
      ['xa', 'save and close all tabs', () => (save(), command('workspace.close-all-tabs'))],
      ['e', 'open another note', () => command('switcher.open')],
      ['bn', 'next tab', () => command('workspace.next-tab')],
      ['bp', 'previous tab', () => command('workspace.previous-tab')],
      ['bd', 'close this tab', () => command('workspace.close-tab')],
      ['grep', 'find in all notes', () => command('search.find')],
    ];

    /** The vim keys for a text field inside a note (a figure's caption). */
    const field = (): Extension => [
      Prec.highest(vim()),
      EditorView.editorAttributes.of({ class: 'pm-vim pm-vim-field' }),
    ];

    // Off until it is switched on: the editor is then as it is without this plugin.
    let active: Disposable | undefined;
    let activeField: Disposable | undefined;
    const apply = () => {
      const on = ctx.settings.get('enabled', false);
      if (on) configure();
      if (on && !active) {
        for (const [name, about, run] of EX)
          exCommands.push(
            ctx.commands.register({ id: `vim.ex.${name}`, title: `${name} — ${about}`, run }),
          );
        active = editor.registerExtension(extension);
        activeField = editor.registerFieldExtension(field);
      }
      if (!on) modeItem.setText('');
      if (!on && active) {
        for (const c of exCommands.splice(0)) c.dispose();
        active.dispose();
        activeField?.dispose();
        active = activeField = undefined;
      }
    };
    apply();
    ctx.register(() => {
      for (const c of exCommands.splice(0)) c.dispose();
      active?.dispose();
      activeField?.dispose();
    });

    ctx.commands.register({
      id: 'vim.toggle',
      title: 'Vim mode: on/off',
      category: 'Vim',
      run: async () => {
        const on = !ctx.settings.get('enabled', false);
        await ctx.settings.set('enabled', on);
        apply();
        workspace.notify(on ? 'Vim mode is on' : 'Vim mode is off', { timeout: 1500 });
      },
    });
    // Escape must not be taken by something else while a leap waits for its keys.
    void leaping;

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'vim',
          title: 'Vim',
          group: 'plugins',
          render(container) {
            const set = (key: string) => (on: boolean) =>
              void ctx.settings.set(key, on).then(apply);
            container.replaceChildren(
              h('h2', {}, 'Vim'),
              settingItem(
                'Vim mode',
                'Normal, insert and visual mode in the editor, with vim’s motions, operators, text objects, registers, marks, macros, search (/ and ?) and commands after “:”. The mode is shown under the note.',
                toggle(ctx.settings.get('enabled', false), set('enabled'), { label: 'Vim mode' }),
              ),
              h('h3', {}, 'Extras'),
              ...EXTRAS.map((e) =>
                settingItem(
                  e.name,
                  e.about,
                  toggle(ctx.settings.get(e.key, e.on), set(e.key), { label: e.name }),
                ),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
