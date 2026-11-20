import { definePlugin, Workspace, WorkspaceShell, type PluginModule } from '@pumice/api';
import '@pumice/ui/theme.css';
import { createRoot, type Root } from 'react-dom/client';
import manifestJson from '../manifest.json';
import { WorkspaceRoot } from './components';
import { WorkspaceModel } from './model';
import './workspace.css';

export { Icon } from './components';

export const manifest = manifestJson;

export const plugin = definePlugin({
  activate(ctx) {
    const model = new WorkspaceModel(ctx);
    ctx.provide(Workspace, model);

    let root: Root | undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      ctx.commands.handleKeyEvent(e);
    };
    const shell = {
      mount(el: HTMLElement, opts: { vaultName: string }) {
        root = createRoot(el);
        root.render(<WorkspaceRoot model={model} vaultName={opts.vaultName} />);
        window.addEventListener('keydown', onKeyDown);
        void model.restoreLayout();
      },
      unmount() {
        window.removeEventListener('keydown', onKeyDown);
        root?.unmount();
        root = undefined;
      },
    };
    ctx.provide(WorkspaceShell, shell);
    ctx.register(() => shell.unmount());

    const hasTab = () => !!model.activeTab;
    ctx.commands.register({
      id: 'workspace.close-tab',
      title: 'Close current tab',
      category: 'Workspace',
      hotkeys: ['Mod+W'],
      when: hasTab,
      run: () => model.activeTab && model.closeTab(model.activeTab),
    });
    ctx.commands.register({
      id: 'workspace.reopen-tab',
      title: 'Reopen closed tab',
      category: 'Workspace',
      hotkeys: ['Mod+Shift+T'],
      run: () => model.reopenClosedTab(),
    });
    ctx.commands.register({
      id: 'workspace.next-tab',
      title: 'Next tab',
      category: 'Workspace',
      hotkeys: ['Ctrl+Tab', 'Mod+Alt+ArrowRight'],
      run: () => model.cycleTab(1),
    });
    ctx.commands.register({
      id: 'workspace.previous-tab',
      title: 'Previous tab',
      category: 'Workspace',
      hotkeys: ['Ctrl+Shift+Tab', 'Mod+Alt+ArrowLeft'],
      run: () => model.cycleTab(-1),
    });
    ctx.commands.register({
      id: 'workspace.toggle-left-sidebar',
      title: 'Toggle left sidebar',
      category: 'Workspace',
      hotkeys: ['Mod+Shift+L'],
      run: () => model.toggleSidebar('left'),
    });
    ctx.commands.register({
      id: 'workspace.toggle-right-sidebar',
      title: 'Toggle right sidebar',
      category: 'Workspace',
      hotkeys: ['Mod+Shift+R'],
      run: () => model.toggleSidebar('right'),
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
