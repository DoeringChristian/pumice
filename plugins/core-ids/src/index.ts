import {
  Documents,
  Editor,
  Links,
  MetadataIndex,
  NoteIds,
  SettingsUi,
  Workspace,
  definePlugin,
  formatWikiLink,
  isNoteId,
  setProperty,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { editNote } from '@pumice/core-links';
import { h, settingItem, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { allowIdEdit, idEditorExtension } from './editor-ext';
import { NoteIdTable } from './ids';

export const manifest = manifestJson;
export { NoteIdTable } from './ids';

export const plugin = definePlugin({
  activate(ctx) {
    const index = ctx.use(MetadataIndex);
    const documents = ctx.use(Documents);
    const links = ctx.use(Links);
    const workspace = ctx.use(Workspace);
    const editor = ctx.use(Editor);

    const ids = new NoteIdTable(index, documents);
    ctx.provide(NoteIds, ids);
    const insertIds = () => ctx.settings.get('insertIdLinks', false);
    const showIds = () => ctx.settings.get('showIds', false);

    // Resolution: `[[id]]` and `[[id|Name]]` find the note carrying that ID.
    void index.ready.then(() => {
      if (ids.refresh()) index.invalidateLinks();
    });
    ctx.register(
      index.onDidChange((paths) => {
        if (ids.refresh(paths)) index.invalidateLinks();
        checkDuplicates();
      }),
    );
    ctx.register(index.registerResolver(ids.resolve));
    // Writing links: only when the user opted in; plain `[[Name]]` links are the default.
    ctx.register(
      links.registerLinkFormatter((file, opts) =>
        insertIds() ? ids.formatLink(file, opts) : undefined,
      ),
    );

    let lastNotice = 0;
    ctx.register(
      editor.registerExtension((ectx) =>
        idEditorExtension(
          {
            index,
            isId: (id) => ids.pathOf(id) !== undefined,
            showIds,
            notifyProtected: () => {
              if (Date.now() - lastNotice < 4000) return;
              lastNotice = Date.now();
              workspace.notify('The note ID is protected. Use “Change note ID” to change it.', {
                kind: 'warning',
              });
            },
          },
          ectx,
        ),
      ),
    );

    // Duplicate IDs (copied files, templates, sync conflicts): tell the user, fix on request.
    let reported = '';
    const checkDuplicates = () => {
      if (!index.isReady) return;
      const dups = ids.duplicates();
      const key = JSON.stringify(dups);
      if (!dups.length || key === reported) return;
      reported = key;
      const n = dups.reduce((sum, [, p]) => sum + p.length, 0);
      workspace.notify(
        `${n} notes share an ID. Run “Fix duplicate note IDs” to give the copies new IDs.`,
        { kind: 'warning', timeout: 8000 },
      );
    };

    const activeNote = () => {
      const path = workspace.activeFile;
      return path && /\.md$/i.test(path) && !/\.excalidraw\.md$/i.test(path) ? path : undefined;
    };
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

    ctx.commands.register({
      id: 'ids.fix-duplicates',
      title: 'Fix duplicate note IDs',
      category: 'Note IDs',
      run: async () => {
        let fixed = 0;
        // The first note of each group keeps the ID.
        for (const [, paths] of ids.duplicates()) {
          for (const path of paths.slice(1)) {
            await ids.reassign(path);
            fixed++;
          }
        }
        workspace.notify(fixed ? `Gave ${plural(fixed, 'note')} a new ID.` : 'No duplicate IDs.');
      },
    });
    ctx.commands.register({
      id: 'ids.assign',
      title: 'Give this note an ID',
      category: 'Note IDs',
      when: () => !!activeNote() && !ids.idOf(activeNote()!),
      run: () => ids.ensureId(activeNote()!),
    });
    ctx.commands.register({
      id: 'ids.assign-all',
      title: 'Give every note an ID',
      category: 'Note IDs',
      run: async () => {
        const missing = index
          .files()
          .filter(
            (f) => /\.md$/i.test(f.path) && !/\.excalidraw\.md$/i.test(f.path) && !ids.idOf(f.path),
          );
        if (!missing.length) return workspace.notify('Every note has an ID.');
        if (!(await workspace.confirm(`Add an ID to ${plural(missing.length, 'note')}?`))) return;
        for (const f of missing) await ids.ensureId(f.path);
        workspace.notify(`Added ${plural(missing.length, 'ID')}.`);
      },
    });
    ctx.commands.register({
      id: 'ids.change',
      title: 'Change note ID',
      category: 'Note IDs',
      when: () => !!activeNote(),
      run: async () => {
        const path = activeNote()!;
        const current = ids.idOf(path);
        const value = (
          await workspace.showPrompt({ title: 'New ID', value: current ?? '' })
        )?.trim();
        if (!value || value === current) return;
        if (!isNoteId(value)) {
          workspace.notify('An ID is 10 characters: a–z without i, l, o, u, and 0–9.', {
            kind: 'error',
          });
          return;
        }
        const owner = ids.pathOf(value);
        if (owner && owner !== path) {
          workspace.notify(`“${owner}” already has that ID.`, { kind: 'error' });
          return;
        }
        const active = editor.active();
        if (active?.path === path) {
          const change = setProperty(active.view.state.doc.toString(), 'id', value);
          if (change) active.view.dispatch({ changes: change, annotations: allowIdEdit.of(true) });
        } else {
          await editNote(documents, path, (text) => {
            const change = setProperty(text, 'id', value);
            return change ? [change] : null;
          });
        }
      },
    });

    /** Rewrites the wikilinks of a note between `[[Name]]` and `[[id|Name]]`. */
    const convert = async (path: VaultPath, to: 'ids' | 'names') => {
      const targets = index
        .outgoing(path)
        .filter((r) => r.target && (r.link.kind === 'link' || r.link.kind === 'embed'))
        .filter((r) =>
          to === 'names' ? r.via === 'plugin' : r.via !== 'plugin' && r.via !== 'self',
        )
        .filter(
          (r) =>
            to === 'names' || (/\.md$/i.test(r.target!) && !/\.excalidraw\.md$/i.test(r.target!)),
        );
      if (!targets.length) return 0;
      const idByTarget = new Map<VaultPath, string>();
      if (to === 'ids')
        for (const r of targets) idByTarget.set(r.target!, await ids.ensureId(r.target!));
      await editNote(documents, path, (text) =>
        targets
          .filter((r) => text.slice(r.link.from, r.link.to).includes(r.link.target))
          .map((r) => {
            const file = index.getFile(r.target!)!;
            const embed = r.link.kind === 'embed';
            const sub = r.link.subpath ? { subpath: r.link.subpath } : {};
            let insert: string;
            if (to === 'ids') {
              insert = formatWikiLink(
                { target: idByTarget.get(r.target!)!, ...sub, alias: r.link.alias ?? file.title },
                { embed },
              );
            } else {
              // An alias that only repeated the note's name is dropped.
              const alias =
                r.link.alias && r.link.alias !== file.title && r.link.alias !== file.name
                  ? { alias: r.link.alias }
                  : {};
              insert = formatWikiLink({ target: nameOf(r.target!), ...sub, ...alias }, { embed });
            }
            return { from: r.link.from, to: r.link.to, insert };
          }),
      );
      return targets.length;
    };
    /** The default `[[Name]]` text even while ID insertion is on. */
    const nameOf = (path: VaultPath) => {
      const file = index.getFile(path)!;
      const clash = index
        .files()
        .some(
          (f) =>
            f.path !== path &&
            f.name.toLowerCase() === file.name.toLowerCase() &&
            /\.md$/i.test(f.path),
        );
      return clash ? path.replace(/\.md$/i, '') : file.name;
    };

    ctx.commands.register({
      id: 'ids.to-name-links',
      title: 'Convert ID links in this note to name links',
      category: 'Note IDs',
      when: () => !!activeNote(),
      run: async () =>
        workspace.notify(`Converted ${plural(await convert(activeNote()!, 'names'), 'link')}.`),
    });
    ctx.commands.register({
      id: 'ids.to-id-links',
      title: 'Convert name links in this note to ID links',
      category: 'Note IDs',
      when: () => !!activeNote(),
      run: async () =>
        workspace.notify(`Converted ${plural(await convert(activeNote()!, 'ids'), 'link')}.`),
    });
    ctx.commands.register({
      id: 'ids.toggle-insert',
      title: 'Insert new links as ID links (on/off)',
      category: 'Note IDs',
      run: async () => {
        await ctx.settings.set('insertIdLinks', !insertIds());
        workspace.notify(
          insertIds()
            ? 'New links are ID links: [[id|Name]]'
            : 'New links are name links: [[Name]]',
          { timeout: 2500 },
        );
      },
    });

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'ids',
          title: 'Note IDs',
          group: 'plugins',
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Note IDs'),
              settingItem(
                'Insert ID links',
                'New links are written as [[id|Name]] and the target note gets an id property. Off: plain [[Name]] links, as in Obsidian. Existing ID links work either way.',
                toggle(insertIds(), (v) => void ctx.settings.set('insertIdLinks', v)),
              ),
              settingItem(
                'Show IDs while editing',
                'Show the raw ID inside [[id|Name]] links instead of folding it.',
                toggle(showIds(), (v) => void ctx.settings.set('showIds', v)),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
