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
  labelChange,
  newLabel,
  validLabel,
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
  formatLocationQuote,
  formatLocationWithText,
  newBlockId,
  type LocationFormat,
} from './location';
import { markdownRenames, rewriteLinksAfterRename } from './rename';
import {
  captionReferences,
  insertReference,
  itemAtPos,
  itemChoices,
  itemsOf,
  renameLabel,
  type ItemChoice,
} from './references';
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

    // A caption can refer to other figures: the same suggestions while it is written.
    ctx.register(editor.registerCaptionExtension((note) => captionReferences(note)));

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
        target.kind === 'heading' ? { subpath: target.heading } : { subpath: target.id },
      );
      await copy(link, 'link');
    };
    const hasEditor = () => !!editor.active();

    // ---- References to figures, tables and equations ----------------------------------------

    /** Lets the user choose one of the note's figures, tables and equations. */
    const pickItem = async (placeholder: string, only?: (c: ItemChoice) => boolean) => {
      const active = editor.active();
      if (!active) return undefined;
      const choices = itemChoices(active.view.state).filter(only ?? (() => true));
      if (!choices.length) {
        workspace.notify('This note has no figures, tables or equations to choose from.');
        return undefined;
      }
      const picked = await workspace.showQuickPick({ placeholder, items: choices });
      return picked && { ...active, item: picked.item };
    };
    /** A place in the note (`pos`), or what the user chooses. */
    const itemFor = async (arg: unknown, placeholder: string, labelled = false) => {
      const active = editor.active();
      const pos = (arg as { pos?: number } | undefined)?.pos;
      if (active && typeof pos === 'number') {
        const item = itemAtPos(active.view.state, pos);
        return item && { ...active, item };
      }
      return pickItem(placeholder, labelled ? (c) => !!c.item.id : undefined);
    };
    ctx.commands.register({
      id: 'links.insert-reference',
      title: 'Insert reference to a figure, table or equation',
      category: 'Links',
      when: hasEditor,
      run: async () => {
        const found = await pickItem('Refer to…');
        if (!found) return;
        const { from, to } = found.view.state.selection.main;
        insertReference(found.view, found.item, { from, to }, 'at');
        found.view.focus();
      },
    });
    ctx.commands.register({
      id: 'links.copy-reference',
      title: 'Copy reference to a figure, table or equation',
      category: 'Links',
      when: hasEditor,
      run: async (arg?: unknown) => {
        const found = await itemFor(arg, 'Copy a reference to…');
        if (!found) return;
        const { view, item } = found;
        let id = item.id;
        if (!id) {
          const text = view.state.doc.toString();
          id = newLabel(item.kind, text);
          view.dispatch({ changes: labelChange(text, item, id), userEvent: 'input.reference' });
        }
        await copy(`@${id}`, `reference @${id}`);
      },
    });
    ctx.commands.register({
      id: 'links.rename-label',
      title: 'Rename the label of a figure, table or equation',
      category: 'Links',
      when: hasEditor,
      run: async (arg?: unknown) => {
        const found = await itemFor(arg, 'Rename the label of…', true);
        if (!found) return;
        const { view, path, item } = found;
        // Written where the label stands (`name`), or asked for.
        const given = (arg as { name?: unknown } | undefined)?.name;
        if (!item.id && typeof given !== 'string') {
          workspace.notify('It has no label yet: it gets one when it is first referred to.');
          return;
        }
        const prefix = `${item.kind}-`;
        const typed =
          typeof given === 'string'
            ? given
            : await workspace.showPrompt({
                title: `New label (references to ${item.id} follow)`,
                value: item.id!,
                selection: [prefix.length, item.id!.length],
              });
        if (typed === undefined) return;
        // Words become a label: `Loss curve` is `fig-loss-curve`.
        const slug = typed
          .trim()
          .replace(new RegExp(`^${prefix}`, 'i'), '')
          .replace(/[^A-Za-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase();
        const id = prefix + slug;
        if (!slug || id === item.id) return;
        if (!validLabel(item.kind, id)) {
          workspace.notify(`"${typed}" cannot be a label.`, { kind: 'warning' });
          return;
        }
        if (itemsOf(view.state).some((i) => i.id === id)) {
          workspace.notify(`This note already has the label ${id}.`, { kind: 'warning' });
          return;
        }
        // One it did not have yet is written where labels of its kind stand.
        if (!item.id) {
          view.dispatch({
            changes: labelChange(view.state.doc.toString(), item, id),
            userEvent: 'input.rename',
          });
          return;
        }
        const others = await renameLabel(view, path, item.id, id, { index, documents });
        workspace.notify(
          `Renamed to ${id}${others ? `, also in ${others} other note${others === 1 ? '' : 's'}` : ''}.`,
          { timeout: 2500 },
        );
      },
    });
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
      id: 'links.copy-location-quote',
      title: 'Copy location and selection (path:line:column "text")',
      category: 'Links',
      when: hasEditor,
      run: async () => {
        const active = editor.active();
        if (!active) return;
        const { state } = active.view;
        const { from, to } = state.selection.main;
        await copy(
          formatLocationQuote(locationPath(active.path), state.doc.toString(), from, to),
          'location',
        );
      },
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
