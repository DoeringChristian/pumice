import {
  Documents,
  Editor,
  Reader,
  Vault,
  Workspace,
  definePlugin,
  type PluginModule,
} from '@pumice/api';
import manifestJson from '../manifest.json';
import { present, type Presentation } from './present';
import './slides.css';

export const manifest = manifestJson;
export { splitSlides, slideAt, type Slide } from './slides';

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const vault = ctx.use(Vault);
    const documents = ctx.use(Documents);
    const reader = ctx.use(Reader);

    let running: { show: Presentation; stop(): void } | undefined;
    ctx.register(() => running?.show.close());

    /** Shows the open note as slides, starting at the slide the cursor is on. */
    const start = async (fromCursor: boolean) => {
      const path = workspace.activeFile;
      if (!path || !/\.(md|markdown)$/i.test(path)) {
        workspace.notify('Open a note to present it.', { kind: 'warning' });
        return;
      }
      running?.show.close();
      const read = async () => documents.peek(path) ?? (await vault.read(path));
      const active = ctx.tryUse(Editor)?.active();
      const cursor =
        fromCursor && active?.path === path ? active.view.state.selection.main.head : 0;
      // While it runs, what is changed in the note shows on the slides.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const sub = documents.onDidChange((changed) => {
        if (changed !== path) return;
        clearTimeout(timer);
        timer = setTimeout(() => void read().then((note) => running?.show.update(note)), 300);
      });
      const stop = () => {
        clearTimeout(timer);
        sub.dispose();
        running = undefined;
        // Back to writing, where the cursor was.
        const editor = ctx.tryUse(Editor)?.active();
        if (editor?.path === path) editor.view.focus();
      };
      const show = present({
        note: await read(),
        path,
        reader,
        startAt: cursor,
        onClose: stop,
      });
      running = { show, stop };
    };

    ctx.commands.register({
      id: 'slides.start',
      title: 'Start presentation',
      category: 'Slides',
      when: () => /\.(md|markdown)$/i.test(workspace.activeFile ?? ''),
      run: () => start(true),
    });
    ctx.commands.register({
      id: 'slides.start-first',
      title: 'Start presentation from the first slide',
      category: 'Slides',
      when: () => /\.(md|markdown)$/i.test(workspace.activeFile ?? ''),
      run: () => start(false),
    });
    ctx.register(
      workspace.registerRibbonAction({
        id: 'slides.start',
        icon: 'presentation',
        title: 'Present this note as slides',
        order: 75,
        run: () => start(true),
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
