import {
  Documents,
  Frames,
  PlatformService,
  Reader,
  Workspace,
  basename,
  definePlugin,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import manifestJson from '../manifest.json';
import { buildPage } from './build';
import { fileName } from './page';

export const manifest = manifestJson;

/** Folder of the vault the exports are written to. */
const FOLDER = 'exports';

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const documents = ctx.use(Documents);
    const reader = ctx.use(Reader);
    const platform = ctx.use(PlatformService);

    const note = (): VaultPath | undefined => {
      const path = workspace.activeFile;
      return path && /\.md$/i.test(path) ? path : undefined;
    };
    /** The videos of the note as they stand in the app: paper gets the picture seen now. */
    const videoTimes = () =>
      [
        ...document.querySelectorAll<HTMLVideoElement>(
          '.pm-leaf:not([hidden]) .pm-markdown-page video',
        ),
      ].map((v) => v.currentTime);
    const failed = (e: unknown) =>
      workspace.notify(`The export failed: ${e instanceof Error ? e.message : String(e)}`, {
        kind: 'error',
      });
    /**
     * Hands a finished export to the user: saved where they say (the system's dialog), or,
     * where there is no such dialog, downloaded (web) or put into the vault's exports folder.
     * `files`: what belongs beside the file, by its path from there.
     */
    const save = async (
      name: string,
      file: string,
      data: string | Uint8Array,
      files?: Map<string, Uint8Array>,
    ) => {
      const beside = files?.size ? files : undefined;
      if (platform.save) {
        const where = beside
          ? await platform.save.folder(name, { [file]: data, ...Object.fromEntries(beside) })
          : await platform.save.file(file, data);
        if (where) workspace.notify(`Saved to ${where}`, { timeout: 6000 });
        return;
      }
      if (platform.kind === 'web' && !beside) {
        const url = URL.createObjectURL(new Blob([data as BlobPart]));
        const link = document.createElement('a');
        link.href = url;
        link.download = file;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
      const folder = beside ? `${FOLDER}/${name}` : FOLDER;
      for (const [path, bytes] of beside ?? []) await platform.fs.write(`${folder}/${path}`, bytes);
      await platform.fs.write(`${folder}/${file}`, data);
      workspace.notify(`Exported to ${folder}/${file}`, { timeout: 6000 });
      void platform.shell.revealInFileManager?.(`${folder}/${file}`)?.catch(() => undefined);
    };
    const build = async (path: VaultPath, kind: 'page' | 'print', inline: boolean) =>
      buildPage({
        path,
        title: basename(path).replace(/\.md$/i, ''),
        markdown: await documents.read(path),
        reader,
        frames: ctx.tryUse(Frames),
        kind,
        inline,
        ...(kind === 'print' ? { videoTimes: videoTimes() } : {}),
      });

    const exportHtml = async (inline: boolean) => {
      const path = note();
      if (!path) return;
      workspace.notify('Exporting…', { timeout: 2000 });
      try {
        const name = fileName(basename(path).replace(/\.md$/i, ''));
        const built = await build(path, 'page', inline);
        if (built.files.size) await save(name, 'index.html', built.html, built.files);
        else await save(name, `${name}.html`, built.html);
      } catch (e) {
        failed(e);
      }
    };
    // One file that holds everything it shows: pictures, videos, frames with their data.
    ctx.commands.register({
      id: 'export.html',
      title: 'Export this note as a web page (one HTML file)',
      category: 'Export',
      when: () => !!note(),
      run: () => exportHtml(true),
    });
    // The same with the pictures and videos as files beside the page (a smaller page, for
    // putting on a web server).
    ctx.commands.register({
      id: 'export.html-folder',
      title: 'Export this note as a web page with its media in a folder',
      category: 'Export',
      when: () => !!note(),
      run: () => exportHtml(false),
    });

    ctx.commands.register({
      id: 'export.pdf',
      title: 'Export this note as a PDF',
      category: 'Export',
      when: () => !!note(),
      run: async () => {
        const path = note();
        if (!path) return;
        try {
          const name = fileName(basename(path).replace(/\.md$/i, ''));
          if (!platform.print) {
            // No printing without a dialog here: the system's own, which can save a PDF.
            const built = await build(path, 'print', true);
            const frame = document.createElement('iframe');
            frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
            frame.srcdoc = built.html;
            document.body.append(frame);
            frame.addEventListener('load', () => {
              setTimeout(() => {
                frame.contentWindow?.focus();
                frame.contentWindow?.print();
                setTimeout(() => frame.remove(), 60000);
              }, 800);
            });
            return;
          }
          workspace.notify('Exporting…', { timeout: 2000 });
          const built = await build(path, 'print', false);
          // The page is written out, printed, and taken away again.
          const work = `.pumice/export-${Date.now().toString(36)}`;
          const written: VaultPath[] = [];
          try {
            for (const [file, bytes] of built.files) {
              await platform.fs.write(`${work}/${file}`, bytes);
              written.push(`${work}/${file}`);
            }
            await platform.fs.write(`${work}/index.html`, built.html);
            written.push(`${work}/index.html`);
            // Printed beside the page, then handed over.
            const pdf = `${work}/print.pdf`;
            written.push(pdf);
            await platform.print.toPdf(`${work}/index.html`, pdf);
            await save(name, `${name}.pdf`, await platform.fs.readBinary(pdf));
          } finally {
            for (const file of written) await platform.fs.remove(file).catch(() => undefined);
            await platform.fs.remove(`${work}/assets`).catch(() => undefined);
            await platform.fs.remove(work).catch(() => undefined);
          }
        } catch (e) {
          failed(e);
        }
      },
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
