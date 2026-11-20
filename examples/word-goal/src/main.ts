/**
 * Example: a word-count goal for the active note.
 * Shows services (Workspace, Documents), a status bar item, a command and a settings tab.
 */
import { Documents, SettingsUi, Workspace, definePlugin } from '@pumice/api';

const countWords = (text: string) =>
  text.replace(/^---\n[\s\S]*?\n---\n/, '').match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;

export default definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const documents = ctx.use(Documents);
    const goal = () => ctx.settings.get('goal', 500);

    const status = ctx.register(workspace.addStatusBarItem(5));
    const update = async () => {
      const path = workspace.activeFile;
      if (!path?.endsWith('.md')) return status.setText('');
      const words = countWords(await documents.read(path));
      const pct = Math.min(100, Math.round((words / goal()) * 100));
      status.setText(`${pct >= 100 ? '🎯' : '✎'} ${words} / ${goal()} words`);
    };
    ctx.register(workspace.onDidChangeActiveFile(() => void update()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    ctx.register(
      documents.onDidChange((path) => {
        if (path !== workspace.activeFile) return;
        clearTimeout(timer);
        timer = setTimeout(() => void update(), 300);
      }),
    );
    ctx.register(() => clearTimeout(timer));
    void update();

    ctx.commands.register({
      id: 'example.word-goal.set',
      title: 'Set word goal',
      category: 'Word goal',
      run: async () => {
        const value = await workspace.showPrompt({
          title: 'Words per note',
          value: String(goal()),
        });
        const n = Number(value);
        if (value && Number.isFinite(n) && n > 0) {
          await ctx.settings.set('goal', Math.round(n));
          void update();
        }
      },
    });

    // Optional dependency: only when the settings window exists.
    const settings = ctx.tryUse(SettingsUi);
    if (settings) {
      ctx.register(
        settings.registerTab({
          id: 'example.word-goal',
          title: 'Word goal',
          group: 'plugins',
          render(el) {
            el.innerHTML = '<h2>Word goal</h2><p class="pm-setting-desc">Words per note:</p>';
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '1';
            input.className = 'pm-text-input';
            input.value = String(goal());
            input.onchange = () =>
              void ctx.settings.set('goal', Number(input.value) || 500).then(update);
            el.append(input);
          },
        }),
      );
    }
  },
});
