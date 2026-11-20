import {
  Links,
  PlatformService,
  Vault,
  Workspace,
  basename,
  definePlugin,
  type PluginModule,
} from '@pumice/api';
import manifestJson from '../manifest.json';
import { AnnotationStore, HIGHLIGHT_COLORS } from './annotations';
import { createPdfView } from './view';
import './pdf.css';

export const manifest = manifestJson;

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    const store = new AnnotationStore({ fs: ctx.use(PlatformService).fs });
    ctx.register(() => store.dispose());
    // Annotations follow their PDF when it is renamed or moved.
    ctx.register(
      vault.onDidChange((changes) => {
        for (const c of changes) {
          if (c.type === 'rename' && (c.entry.kind === 'folder' || /\.pdf$/i.test(c.oldPath)))
            void store.moved(c.oldPath, c.entry.path, c.entry.kind);
        }
      }),
    );

    ctx.register(
      workspace.registerView({
        type: 'pdf',
        title: 'PDF',
        icon: 'book-open',
        create: (view, state) =>
          createPdfView(view, state, {
            vault,
            workspace,
            store,
            link: (path, subpath) => {
              const links = ctx.tryUse(Links);
              try {
                if (links) return links.formatLink(path, { subpath });
              } catch {
                // Not indexed yet: fall through to the plain form.
              }
              return `[[${basename(path)}#${subpath}]]`;
            },
            lastColor: () => ctx.settings.get('color', HIGHLIGHT_COLORS[0]!.value),
            setLastColor: (color) => void ctx.settings.set('color', color),
          }),
      }),
    );
    ctx.register(workspace.registerFileHandler({ viewType: 'pdf', extensions: ['pdf'] }));
  },
});

export default { manifest, plugin } satisfies PluginModule;
