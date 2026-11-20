import {
  Agents,
  MetadataIndex,
  PlatformService,
  Reader,
  SettingsUi,
  Vault,
  Workspace,
  basename,
  definePlugin,
  type PluginModule,
  type VaultPath,
  type ViewState,
} from '@pumice/api';
import { h, settingItem, textInput, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { mountFrame, type FrameDeps } from './frame';
import { TEMPLATE, agentGuidance, styleGuide } from './kit';
import { frameSlug, parseFrameBlock, parseFrameQuery } from './spec';
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
          await mountFrame(
            container,
            { spec, sourcePath: rctx.sourcePath, register: (d) => rctx.register(d) },
            deps,
          );
        },
      }),
    );
    // ![[file.html]], optionally ![[file.html#key=value&…|height]].
    ctx.register(
      reader.registerEmbedRenderer({
        id: 'frame',
        extensions: ['html', 'htm'],
        render: async (ectx) => {
          const height = Number.parseInt(ectx.alias ?? '', 10);
          await mountFrame(
            ectx.container,
            {
              spec: {
                file: ectx.file!.path,
                ...(height > 0 ? { height } : {}),
                settings: parseFrameQuery(ectx.subpath),
              },
              sourcePath: ectx.sourcePath,
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

    // ---- Writing frames ---------------------------------------------------------------------

    const guidePath = () => (folder() ? `${folder()}/README.md` : 'README.md');
    /** Keeps the style guide in the frames folder (where agents and people find it). */
    const writeGuide = async (overwrite: boolean) => {
      const path = guidePath();
      const exists = vault.get(path);
      if (exists && !overwrite) return;
      if (exists) await vault.write(path, styleGuide(folder()));
      else await vault.create(path, styleGuide(folder()));
    };

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
        const block = `\`\`\`frame\nfile: [[${path}]]\ntitle: Hello\n\`\`\`\n`;
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
