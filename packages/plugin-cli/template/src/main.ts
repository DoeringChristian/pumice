import { Workspace, definePlugin } from '@pumice/api';

export default definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);

    ctx.commands.register({
      id: '__ID__.hello',
      title: 'Say hello',
      category: '__NAME__',
      run: () =>
        workspace.notify(
          `Hello from __NAME__! The active note is ${workspace.activeFile ?? 'none'}.`,
        ),
    });

    // Everything registered through ctx is cleaned up when the plugin is turned off.
    const status = ctx.register(workspace.addStatusBarItem());
    status.setText('__NAME__ ✓');
  },
});
