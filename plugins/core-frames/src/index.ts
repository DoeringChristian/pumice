import { Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  Agents,
  Editor,
  Frames,
  MetadataIndex,
  PlatformService,
  Reader,
  SettingsUi,
  Vault,
  Workspace,
  basename,
  definePlugin,
  editorCompletions,
  parseEmbedSize,
  type PluginModule,
  type VaultPath,
  type ViewState,
} from '@pumice/api';
import { h, settingItem, textInput, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { frameCompletionSource } from './completion';
import { exportFrameHtml, mountFrame, resolveEntry, type FrameDeps } from './frame';
import { GUIDE_VERSION, SERIES, TEMPLATE, THEME_VARS, agentGuidance, styleGuide } from './kit';
import {
  blockText,
  fileRef,
  frameFence,
  frameSlug,
  frameWidth,
  parseFrameBlock,
  parseFrameQuery,
  plainPath,
  type FrameSpec,
  withSettings,
} from './spec';
import {
  frameBlock,
  isFrameManifest,
  opens,
  parseFrameManifest,
  viewerAt,
  type FrameViewer,
} from './viewers';
import './frames.css';

export const manifest = manifestJson;

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);
    const reader = ctx.use(Reader);
    const platform = ctx.use(PlatformService);
    const folder = () =>
      ctx.settings
        .get('folder', 'frames')
        .trim()
        .replace(/^\/+|\/+$/g, '');
    const deps: FrameDeps = {
      vault,
      index: ctx.use(MetadataIndex),
      frames: platform.frames,
      folder,
      network: () => ctx.settings.get('network', false),
      viewerFor: (entry) => viewers.find((v) => v.entry === entry),
      notify: (message) => workspace.notify(message, { kind: 'warning', timeout: 4000 }),
    };

    /** The editor a rendered frame sits in, if the note can be changed there. */
    const editorOf = (element: HTMLElement) => {
      // Looked up from the editor's own element (not from inside one of its widgets).
      const editor = element.closest<HTMLElement>('.cm-editor');
      const view = editor ? EditorView.findFromDOM(editor) : null;
      return view && !view.state.readOnly ? view : undefined;
    };
    /** Writes new settings into the frame block an element was rendered from. */
    const persistBlock = (container: HTMLElement, settings: Record<string, unknown>) => {
      const view = editorOf(container);
      const block = container.closest<HTMLElement>('.cm-pm-block');
      if (!view || !block) return false;
      const { doc } = view.state;
      const start = doc.lineAt(view.posAtDOM(block)).number;
      const lines: string[] = [];
      for (let n = start; n <= Math.min(doc.lines, start + 2000); n++) lines.push(doc.line(n).text);
      const fence = frameFence(lines, 0);
      if (!fence) return false;
      const empty = fence.last < fence.first;
      const from = doc.line(start + fence.first).from;
      const to = empty ? from : doc.line(start + fence.last).to;
      const yaml = withSettings(empty ? '' : doc.sliceString(from, to), settings);
      view.dispatch({
        changes: { from, to, insert: empty ? `${yaml}\n` : yaml },
        userEvent: 'input.frame',
      });
      return true;
    };
    /**
     * An embed (`![[x.html]]`) can only carry simple settings: when it gets more, it becomes a
     * frame block, if it has its line to itself.
     */
    const persistEmbed = (container: HTMLElement, spec: FrameSpec) => {
      const view = editorOf(container);
      const host = container.closest<HTMLElement>('.cm-pm-embed');
      if (!view || !host) return false;
      const line = view.state.doc.lineAt(view.posAtDOM(host));
      if (!/^\s*!\[\[[^\]]*\]\]\s*$/.test(line.text)) {
        workspace.notify(
          'Put this frame on a line of its own to add files to it (it is then written as a frame block).',
          { kind: 'warning', timeout: 5000 },
        );
        return false;
      }
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: blockText(spec) },
        userEvent: 'input.frame',
      });
      return true;
    };

    // ```frame … ``` : an HTML file with settings.
    ctx.register(
      reader.registerCodeBlockRenderer({
        language: 'frame',
        render: async (source, container, rctx) => {
          let spec;
          try {
            spec = parseFrameBlock(source);
          } catch (e) {
            container.replaceChildren(
              h('div', { class: 'pm-frame-error' }, e instanceof Error ? e.message : String(e)),
            );
            return;
          }
          const mounted = await mountFrame(
            container,
            {
              spec,
              sourcePath: rctx.sourcePath,
              persist: (settings) => persistBlock(container, settings),
              register: (d) => rctx.register(d),
            },
            deps,
          );
          // The block changed in the note: the frame takes the new settings over, without
          // being rendered anew, when it still is the same frame.
          container.addEventListener('pumice-block-source', (event) => {
            const lines = String((event as CustomEvent).detail)
              .replace(/\n$/, '')
              .split('\n');
            try {
              if (mounted.setSpec(parseFrameBlock(lines.slice(1, -1).join('\n'))))
                event.preventDefault();
            } catch {
              // Not a valid block (any more): it is rendered anew, with its message.
            }
          });
        },
      }),
    );
    // ![[file.html]], optionally ![[file.html#key=value&…|600x400]].
    ctx.register(
      reader.registerEmbedRenderer({
        id: 'frame',
        extensions: ['html', 'htm'],
        render: async (ectx) => {
          // As for pictures: `|600` is a width, `|600x400` a width and a height.
          const { w, h: tall } = parseEmbedSize(ectx.alias);
          const height = tall && /^(px)?$/.test(tall.unit) ? tall.value : undefined;
          const width = frameWidth(w);
          const spec: FrameSpec = {
            file: ectx.file!.path,
            ...(width ? { width } : {}),
            ...(height ? { height } : {}),
            // A value that names a file of the vault is passed as that file.
            settings: Object.fromEntries(
              Object.entries(parseFrameQuery(ectx.subpath)).map(([key, value]) => [
                key,
                vault.get(value)?.kind === 'file' ? fileRef(value) : value,
              ]),
            ),
          };
          await mountFrame(
            ectx.container,
            {
              spec,
              sourcePath: ectx.sourcePath,
              persist: (settings) => persistEmbed(ectx.container, { ...spec, settings }),
              register: (d) => ectx.register(d),
            },
            deps,
          );
        },
      }),
    );

    // An HTML file opened from the file list fills a tab.
    ctx.register(
      workspace.registerView({
        type: 'frame',
        title: 'Frame',
        icon: 'code',
        create(view, initial) {
          const page = h('div', { class: 'pm-frame-page' });
          view.container.append(page);
          let path: VaultPath | undefined;
          let disposers: Array<() => void> = [];
          const release = () => {
            disposers.forEach((d) => d());
            disposers = [];
          };
          const show = async (next: VaultPath | undefined) => {
            release();
            path = next;
            page.replaceChildren();
            if (!path) return;
            view.setFile(path);
            view.setTitle(basename(path));
            await mountFrame(
              page,
              {
                spec: { file: path, settings: {} },
                sourcePath: path,
                fill: true,
                register: (d) => disposers.push(typeof d === 'function' ? d : () => d.dispose()),
              },
              deps,
            );
          };
          void show(typeof initial.path === 'string' ? initial.path : undefined);
          return {
            getState: (): ViewState => (path ? { path } : {}),
            setState: (state) => show(typeof state.path === 'string' ? state.path : undefined),
            dispose: release,
          };
        },
      }),
    );
    ctx.register(workspace.registerFileHandler({ viewType: 'frame', extensions: ['html', 'htm'] }));

    // ---- Frames as viewers for file types ---------------------------------------------------

    // A file opened through a frame that offers itself for its type (frame.json).
    ctx.register(
      workspace.registerView({
        type: 'frame-viewer',
        title: 'Viewer',
        icon: 'eye',
        create(view, initial) {
          const name = h('span', { class: 'pm-frame-viewer-name' });
          const change = h(
            'button',
            { class: 'pm-frame-viewer-change', type: 'button', title: 'Open with another viewer' },
            'Open with…',
          );
          const bar = h('div', { class: 'pm-frame-viewer-bar' }, name, change);
          const page = h('div', { class: 'pm-frame-page' });
          view.container.append(h('div', { class: 'pm-frame-viewer' }, bar, page));
          let state: ViewState = {};
          let disposers: Array<() => void> = [];
          const release = () => {
            disposers.forEach((d) => d());
            disposers = [];
          };
          change.addEventListener('click', () => {
            if (typeof state.path === 'string') void workspace.openFileWith(state.path);
          });
          const show = async (next: ViewState) => {
            release();
            state = next;
            page.replaceChildren();
            const path = typeof next.path === 'string' ? next.path : undefined;
            const frame = typeof next.frame === 'string' ? next.frame : undefined;
            if (!path || !frame) return;
            view.setFile(path);
            view.setTitle(basename(path));
            name.textContent =
              workspace.viewersFor(path).find((v) => v.id === `frame:${frame}`)?.title ?? frame;
            change.hidden = workspace.viewersFor(path).length < 2;
            await mountFrame(
              page,
              {
                spec: {
                  file: frame,
                  settings: {
                    [typeof next.setting === 'string' ? next.setting : 'data']:
                      next.multiple === true ? [fileRef(path)] : fileRef(path),
                  },
                },
                sourcePath: path,
                fill: true,
                register: (d) => disposers.push(typeof d === 'function' ? d : () => d.dispose()),
              },
              deps,
            );
          };
          void show(initial);
          return {
            getState: (): ViewState => ({ ...state }),
            setState: (next) => show(next),
            dispose: release,
          };
        },
      }),
    );

    const hasFrames = () => {
      const prefix = folder() ? `${folder()}/` : '';
      return vault
        .files()
        .some(
          (f) =>
            f.path.startsWith(prefix) && /^[^/]+\/index\.html?$/.test(f.path.slice(prefix.length)),
        );
    };
    let viewers: FrameViewer[] = [];
    let viewerHandlers: Array<{ dispose(): void }> = [];
    let scanning: Promise<void> = Promise.resolve();
    /** Reads every frame's manifest and offers the frames for the file types they name. */
    const scanViewers = () => {
      scanning = scanning.then(async () => {
        const found: FrameViewer[] = [];
        for (const file of vault.files()) {
          if (!isFrameManifest(file.path, folder())) continue;
          try {
            const viewer = parseFrameManifest(await vault.read(file.path), file.path);
            if (viewer && vault.get(viewer.entry)) found.push(viewer);
          } catch {
            // Unreadable manifest: that frame offers nothing.
          }
        }
        viewers = found;
        // A vault with frames has their guide, so that agents find it.
        if (hasFrames() && !vault.get(guidePath())) await writeGuide(false).catch(() => undefined);
        viewerHandlers.forEach((d) => d.dispose());
        viewerHandlers = found.map((v) =>
          workspace.registerFileHandler({
            viewType: 'frame-viewer',
            id: `frame:${v.entry}`,
            title: v.name,
            extensions: v.extensions,
            state: { frame: v.entry, setting: v.setting, multiple: v.multiple },
            // Never takes a type over from the app's own view of it.
            optional: true,
          }),
        );
      });
      return scanning;
    };
    void scanViewers();
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    ctx.register(
      vault.onDidChange((changes) => {
        const touched = changes.some((c) => {
          const paths = [c.type === 'delete' ? c.path : c.entry.path];
          if (c.type === 'rename') paths.push(c.oldPath);
          const prefix = folder() ? `${folder()}/` : '';
          return (
            paths.some(
              (p) => p.startsWith(prefix) && /(^|\/)(frame\.json|index\.html?)$/.test(p),
            ) ||
            (c.type !== 'modify' && paths.some((p) => p === folder() || p.startsWith(prefix)))
          );
        });
        if (!touched) return;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => void scanViewers(), 300);
      }),
    );
    ctx.register(() => {
      clearTimeout(scanTimer);
      viewerHandlers.forEach((d) => d.dispose());
    });

    // Suggestions while writing a frame block: the frame, its settings, the files it takes.
    const editorApi = ctx.tryUse(Editor);
    if (editorApi) {
      ctx.register(
        editorApi.registerExtension((ectx) =>
          // Before the link suggestions, which would offer every note for `[[`.
          Prec.high(
            editorCompletions.of(
              frameCompletionSource({
                sourcePath: () => ectx.path(),
                files: () =>
                  vault
                    .files()
                    .map((f) => f.path)
                    .filter((p) => !p.startsWith(`${folder()}/`) && !p.startsWith('.')),
                entryOf: (file, sourcePath) => {
                  try {
                    return resolveEntry(file, sourcePath, deps);
                  } catch {
                    return undefined;
                  }
                },
                frames: () => {
                  const prefix = folder() ? `${folder()}/` : '';
                  return vault
                    .files()
                    .map((f) => f.path)
                    .filter(
                      (p) =>
                        p.startsWith(prefix) &&
                        /^[^/]+\/index\.html?$/.test(p.slice(prefix.length)),
                    )
                    .sort()
                    .map((entry) => {
                      const viewer = viewers.find((v) => v.entry === entry);
                      return {
                        entry,
                        name: viewer?.name ?? entry.slice(prefix.length).split('/')[0]!,
                        ...(viewer ? { viewer } : {}),
                      };
                    });
                },
              }),
            ),
          ),
        ),
      );
    }

    // ---- Putting frames into notes ----------------------------------------------------------

    /** Lets the user choose the files a frame should show (several, if it takes a list). */
    const pickFiles = async (viewer: FrameViewer): Promise<VaultPath[] | undefined> => {
      const candidates = vault
        .files()
        .map((f) => f.path)
        .filter((p) => opens(viewer, p) && !p.startsWith(`${folder()}/`))
        .sort();
      if (!candidates.length) {
        workspace.notify(
          `There is no ${viewer.extensions.map((e) => `.${e}`).join(', ')} file in this vault for ${viewer.name}.`,
          { kind: 'warning' },
        );
        return [];
      }
      const chosen: VaultPath[] = [];
      for (;;) {
        const done = { label: `Done (${chosen.length} chosen)`, path: '' };
        const picked = await workspace.showQuickPick({
          placeholder: chosen.length
            ? `Add another file to compare in ${viewer.name}, or finish`
            : `File to show in ${viewer.name}`,
          items: [
            ...(chosen.length ? [done] : []),
            ...candidates
              .filter((p) => !chosen.includes(p))
              .map((p) => ({ label: basename(p), detail: p, path: p })),
          ],
        });
        if (!picked) return chosen.length ? chosen : undefined;
        if (!picked.path) return chosen;
        chosen.push(picked.path);
        if (!viewer.multiple || chosen.length === candidates.length) return chosen;
      }
    };

    /** The frame to show files of one type with: the only one, the remembered one, or asked. */
    const chooseViewer = async (paths: VaultPath[]): Promise<FrameViewer | null | undefined> => {
      const able = viewers.filter((v) => paths.every((p) => opens(v, p)));
      if (able.length < 2) return able[0];
      const type = paths[0]!.slice(paths[0]!.lastIndexOf('.') + 1).toLowerCase();
      const remembered = ctx.settings.get<Record<string, string>>('showWith', {})[type];
      const known = able.find((v) => v.entry === remembered);
      if (known) return known;
      const picked = await workspace.showQuickPick({
        placeholder: `Show ${basename(paths[0]!)} with…`,
        items: able.map((v) => ({ label: v.name, detail: v.entry, entry: v.entry })),
      });
      if (!picked) return null;
      await ctx.settings.set('showWith', {
        ...ctx.settings.get<Record<string, string>>('showWith', {}),
        [type]: picked.entry,
      });
      return able.find((v) => v.entry === picked.entry);
    };

    const insertionFor = async (
      paths: VaultPath[],
      _sourcePath: VaultPath,
    ): Promise<string | null | undefined> => {
      await scanning;
      if (!paths.length) return undefined;
      // A frame itself was dropped: ask what it should show.
      const frame = paths.length === 1 ? viewerAt(viewers, paths[0]!) : undefined;
      if (frame) {
        const files = await pickFiles(frame);
        return files === undefined ? null : frameBlock(frame, files);
      }
      // A frame without a manifest, dropped as its folder: show it as it is.
      const only = paths[0]!;
      if (paths.length === 1 && vault.get(only)?.kind === 'folder') {
        const entry = `${only}/index.html`;
        return vault.get(entry)?.kind === 'file' ? `![[${entry}]]` : undefined;
      }
      // Files the app shows itself (pictures, PDFs, notes) are embedded the usual way.
      if (paths.some((p) => vault.get(p)?.kind !== 'file' || reader.canEmbed(p))) return undefined;
      const viewer = await chooseViewer(paths);
      if (viewer === null) return null;
      if (!viewer) return undefined;
      return viewer.multiple || paths.length === 1
        ? frameBlock(viewer, viewer.multiple ? paths : paths.slice(0, 1))
        : paths.map((p) => frameBlock(viewer, [p])).join('\n\n');
    };
    ctx.provide(Frames, {
      insertionFor,
      exportHtml: (figure, opts) => exportFrameHtml(figure, !!opts?.light),
      themeKeys: () => ({ vars: [...THEME_VARS], series: SERIES }),
    });

    ctx.commands.register({
      id: 'frames.insert',
      title: 'Insert a frame into the note…',
      category: 'Frames',
      run: async () => {
        const active = ctx.tryUse(Editor)?.active();
        if (!active) {
          workspace.notify('Open a note for editing first.', { kind: 'warning' });
          return;
        }
        await scanning;
        // Every frame in the frames folder, with or without a manifest.
        const prefix = folder() ? `${folder()}/` : '';
        const entries = vault
          .files()
          .map((f) => f.path)
          .filter(
            (p) => p.startsWith(prefix) && /^[^/]+\/index\.html?$/.test(p.slice(prefix.length)),
          );
        if (!entries.length) {
          workspace.notify(`There are no frames in ${folder() || 'the vault'} yet.`, {
            kind: 'warning',
          });
          return;
        }
        const picked = await workspace.showQuickPick({
          placeholder: 'Frame to insert',
          items: entries.map((entry) => {
            const viewer = viewers.find((v) => v.entry === entry);
            return {
              label: viewer?.name ?? entry.slice(prefix.length).split('/')[0]!,
              detail: viewer ? `shows ${viewer.extensions.map((e) => `.${e}`).join(', ')}` : entry,
              entry,
            };
          }),
        });
        if (!picked) return;
        const viewer = viewers.find((v) => v.entry === picked.entry);
        const files = viewer ? await pickFiles(viewer) : [];
        if (files === undefined) return;
        const text = viewer
          ? frameBlock(viewer, files)
          : `\`\`\`frame\nfile: ${plainPath(picked.entry)}\n\`\`\``;
        const { state } = active.view;
        const line = state.doc.lineAt(state.selection.main.head);
        // On lines of its own, so it renders as a block.
        active.view.dispatch({
          changes: {
            from: line.text.trim() ? line.to : line.from,
            to: line.to,
            insert: `${line.text.trim() ? '\n\n' : ''}${text}\n`,
          },
          userEvent: 'input',
        });
      },
    });

    // ---- Writing frames ---------------------------------------------------------------------

    const guidePath = () => (folder() ? `${folder()}/README.md` : 'README.md');
    /** Keeps the style guide in the frames folder (where agents and people find it). */
    const writeGuide = async (overwrite: boolean) => {
      const path = guidePath();
      const exists = vault.get(path);
      if (exists && !overwrite) return;
      const text = styleGuide(folder());
      if (exists) await vault.write(path, text);
      else await vault.create(path, text);
      await ctx.settings.set('guideWritten', text);
    };
    // A guide from an older version that nobody edited is brought up to date, so agents do
    // not keep following outdated rules. An edited one is left alone.
    void (async () => {
      const path = guidePath();
      if (!vault.get(path)) return;
      const current = await vault.read(path);
      if (current.includes(`pumice-frames-guide: ${GUIDE_VERSION} `)) return;
      const written = ctx.settings.get<string | undefined>('guideWritten', undefined);
      const untouched =
        written !== undefined
          ? current === written
          : /^# Frames\n\nA frame is an HTML file/.test(current);
      if (untouched) await writeGuide(true);
    })().catch(() => undefined);

    ctx.commands.register({
      id: 'frames.new',
      title: 'New frame (an HTML file to show in notes)',
      category: 'Frames',
      run: async () => {
        const name = await workspace.showPrompt({ title: 'Name of the frame', value: 'my-frame' });
        const slug = name ? frameSlug(name) : '';
        if (!slug) return;
        const dir = folder() ? `${folder()}/${slug}` : slug;
        const path = `${dir}/index.html`;
        if (vault.get(path)) {
          workspace.notify(`${path} already exists.`, { kind: 'warning' });
          return;
        }
        await writeGuide(false);
        await vault.create(
          path,
          TEMPLATE.replace(/FOLDER\/NAME\/index\.html/g, path)
            .replace(/!\[\[NAME\.html\]\]/g, `![[${path}]]`)
            .replace(/FOLDER\/README\.md/g, guidePath())
            .replace(/NAME/g, slug),
        );
        const block = `\`\`\`frame\nfile: ${plainPath(path)}\ntitle: Hello\n\`\`\`\n`;
        await navigator.clipboard.writeText(block).catch(() => undefined);
        await workspace.openFile(path);
        workspace.notify(
          'Frame created. A block that shows it is on the clipboard: paste it into a note.',
          {
            timeout: 5000,
          },
        );
      },
    });
    ctx.commands.register({
      id: 'frames.write-guide',
      title: 'Write the style guide for frames (README in the frames folder)',
      category: 'Frames',
      run: async () => {
        await writeGuide(true);
        await workspace.openFile(guidePath());
      },
    });

    // Agents learn how frames work, and that they follow the style guide.
    const agents = ctx.tryUse(Agents);
    if (agents) ctx.register(agents.registerGuidance(() => agentGuidance(folder())));

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'frames',
          title: 'Frames',
          group: 'app',
          order: 25,
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Frames'),
              h(
                'p',
                { class: 'pm-setting-note' },
                'Frames are HTML files shown inside notes, for example visualizations written by the assistant. Each frame is a folder with an index.html; a note shows it with ![[…/index.html]] or a frame block that passes settings and data files.',
              ),
              settingItem(
                'Folder for frames',
                'Where new frames and their style guide are kept.',
                textInput(
                  folder(),
                  (value) =>
                    void ctx.settings.set('folder', value.trim().replace(/^\/+|\/+$/g, '')),
                  { placeholder: 'frames', label: 'Folder for frames' },
                ),
              ),
              settingItem(
                'Let frames use the network',
                'Off: a frame can only load its own folder and the files its note passes to it, so it cannot send anything out. On: frames can load from and send to the internet. Applies to frames opened from now on (desktop app).',
                toggle(deps.network(), (on) => void ctx.settings.set('network', on), {
                  label: 'Let frames use the network',
                }),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
