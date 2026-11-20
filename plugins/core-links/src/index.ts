import {
  Documents,
  Editor,
  Links,
  MetadataIndex,
  PlatformService,
  Vault,
  Workspace,
  definePlugin,
  formatWikiLink,
  isNoteId,
  setProperty,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import manifestJson from '../manifest.json';
import { linkEditorExtension } from './editor-ext';
import { LinksImpl, editNote } from './links';
import {
  blockTarget,
  formatLocation,
  formatLocationWithText,
  newBlockId,
  type LocationFormat,
} from './location';
import { markdownRenames, rewriteLinksAfterRename } from './rename';
import './links.css';

export { LinksImpl, editNote } from './links';
export { pointedAt, rewriteLinksAfterRename } from './rename';
export * from './location';

export const manifest = manifestJson;

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const documents = ctx.use(Documents);
    const index = ctx.use(MetadataIndex);
    const workspace = ctx.use(Workspace);
    const editor = ctx.use(Editor);

    const links = new LinksImpl({
      vault,
      documents,
      index,
      workspace,
      newNoteFolder: () => ctx.settings.get('newNoteFolder', ''),
    });
    ctx.provide(Links, links);

    ctx.register(
      editor.registerExtension((editorCtx) =>
        linkEditorExtension({ links, index, workspace }, editorCtx),
      ),
    );

    // Links follow renames made in the app, as in Obsidian.
    ctx.register(
      vault.onDidChange((changes) => {
        if (!ctx.settings.get('updateLinksOnRename', true)) return;
        const renames = markdownRenames(changes);
        if (!renames.length) return;
        void rewriteLinksAfterRename(renames, index, documents).then((n) => {
          if (n) workspace.notify(`Updated ${n} link${n === 1 ? '' : 's'}.`, { timeout: 2500 });
        });
      }),
    );

    // ---- Copy location (docs/plan/09) -------------------------------------------------------

    const platform = ctx.use(PlatformService);
    const locationPath = (path: VaultPath) => {
      const root = platform.vaultRoot;
      return ctx.settings.get('locationAbsolute', false) && root
        ? `${root.replace(/[\\/]+$/, '')}/${path}`
        : path;
    };
    const format = () => ctx.settings.get<LocationFormat>('locationFormat', 'colon');
    const copy = async (text: string, what: string) => {
      await navigator.clipboard.writeText(text);
      workspace.notify(`Copied ${what}`, { timeout: 1500 });
    };
    const copyLocation = async (withText: boolean) => {
      const active = editor.active();
      if (!active) return;
      const { state } = active.view;
      const { from, to } = state.selection.main;
      const text = state.doc.toString();
      const fn = withText ? formatLocationWithText : formatLocation;
      await copy(
        fn(locationPath(active.path), text, from, to, format()),
        withText ? 'location and text' : 'location',
      );
    };
    const copyBlockLink = async () => {
      const active = editor.active();
      if (!active) return;
      const { view, path } = active;
      const target = blockTarget(
        view.state.doc.toString(),
        view.state.selection.main.head,
        newBlockId,
      );
      if (target.kind === 'block' && target.insert) {
        view.dispatch({ changes: { from: target.insert.at, insert: target.insert.text } });
      }
      const title = index.getFile(path)?.title;
      const link = await links.linkTo(
        path,
        target.kind === 'heading' ? { subpath: target.heading } : { subpath: `^${target.id}` },
      );
      await copy(link, 'link');
    };
    const hasEditor = () => !!editor.active();
    ctx.commands.register({
      id: 'links.copy-location',
      title: 'Copy location (path:line)',
      category: 'Links',
      hotkeys: ['Mod+Alt+C'],
      when: hasEditor,
      run: () => copyLocation(false),
    });
    ctx.commands.register({
      id: 'links.copy-location-with-text',
      title: 'Copy location with text',
      category: 'Links',
      when: hasEditor,
      run: () => copyLocation(true),
    });
    ctx.commands.register({
      id: 'links.copy-block-link',
      title: 'Copy link to block',
      category: 'Links',
      when: hasEditor,
      run: copyBlockLink,
    });
    for (const [id, label, order, run] of [
      ['copy-location', 'Copy location', 20, () => copyLocation(false)],
      ['copy-location-with-text', 'Copy location with text', 21, () => copyLocation(true)],
      ['copy-block-link', 'Copy link to block', 22, copyBlockLink],
    ] as const) {
      ctx.register(editor.registerContextMenuItem({ id: `links.${id}`, label, order, run }));
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
