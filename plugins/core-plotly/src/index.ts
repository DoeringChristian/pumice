import { Documents, Reader, SettingsUi, definePlugin, type PluginModule } from '@pumice/api';
import { h, settingItem, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';
import { figureSize, parseFigure, themedLayout, type Colors } from './figure';
import './plotly.css';

/**
 * Plotly figures in notes. A figure is a file of its own (`loss.plotly.json`, as Plotly writes
 * it), shown where a note embeds it: `![[loss.plotly.json|Loss over time]]{#fig-loss}`. Its
 * data is never written into the note.
 */

export const manifest = manifestJson;

type Plotly = typeof import('plotly.js-strict-dist-min');
let plotly: Promise<Plotly> | undefined;
/** Loaded with the first figure (it is large). */
const loadPlotly = () =>
  (plotly ??= import('plotly.js-strict-dist-min').then(
    (m) => ((m as unknown as { default?: Plotly }).default ?? m) as Plotly,
  ));

const isDark = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (document.documentElement.dataset.theme !== 'light' &&
    matchMedia('(prefers-color-scheme: dark)').matches);

function colors(el: HTMLElement): Colors {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    dark: isDark(),
    text: v('--text', '#2b2723'),
    muted: v('--text-muted', '#7a726a'),
    grid: v('--border', '#e4e0d9'),
    font: v('--font-ui', 'system-ui, sans-serif'),
  };
}

/** A height for a figure that names none: as Plotly's own, at most as tall as it is wide. */
const heightFor = (width: number) => Math.round(Math.min(450, Math.max(240, width * 0.62)));

export const plugin = definePlugin({
  activate(ctx) {
    const reader = ctx.use(Reader);
    const documents = ctx.use(Documents);
    /** Plotly's own toolbar (zoom, pan, reset, …): hidden unless asked for in the settings. */
    const toolbar = () => ctx.settings.get('toolbar', false);
    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi)
      ctx.register(
        settingsUi.registerTab({
          id: 'plotly',
          title: 'Plotly figures',
          group: 'plugins',
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Plotly figures'),
              settingItem(
                'Show the toolbar',
                "Plotly's own buttons above a figure, shown while the pointer is on it: zoom, pan, reset the view and the like. Without them a figure is still zoomed by dragging over it and reset with a double click.",
                toggle(toolbar(), (on) => void ctx.settings.set('toolbar', on), {
                  label: 'Show the toolbar',
                }),
              ),
            );
          },
        }),
      );

    ctx.register(
      reader.registerEmbedRenderer({
        id: 'plotly',
        extensions: ['plotly.json'],
        measure: async (file) => {
          try {
            return figureSize(parseFigure(await documents.read(file.path)));
          } catch {
            return undefined;
          }
        },
        render: async (embed) => {
          const box = document.createElement('div');
          box.className = 'pm-plotly pm-embed-media';
          // Until it is drawn (an export waits for it).
          box.dataset.pmDrawing = '';
          // It is turned, zoomed and hovered: not dragged around the note.
          box.dataset.pmInteractive = '';
          embed.container.append(box);
          let figure;
          let Plotly;
          try {
            figure = parseFigure(await documents.read(embed.file!.path));
            Plotly = await loadPlotly();
          } catch (e) {
            box.remove();
            throw e;
          }
          const own = typeof figure.layout.height === 'number' ? figure.layout.height : undefined;
          const draw = () => {
            const width = box.clientWidth || 600;
            const layout = themedLayout(figure, colors(box));
            layout.height = own ?? heightFor(width);
            return Plotly.react(box, figure.data, layout, {
              responsive: false,
              displayModeBar: toolbar() ? 'hover' : false,
              displaylogo: false,
              scrollZoom: true,
              modeBarButtonsToRemove: ['sendDataToCloud', 'toImage', 'select2d', 'lasso2d'],
            });
          };
          // The wheel zooms a figure that was clicked into (until the pointer leaves it), and a
          // pinch always does; otherwise it scrolls the note past it.
          let engaged = false;
          // (Before Plotly sees it: it keeps some of it to itself.)
          box.addEventListener('pointerdown', () => (engaged = true), { capture: true });
          box.addEventListener('mousedown', () => (engaged = true), { capture: true });
          box.addEventListener('pointerleave', () => (engaged = false));
          box.addEventListener(
            'wheel',
            (e) => {
              if (!engaged && !e.ctrlKey) e.stopPropagation();
            },
            { capture: true },
          );
          await draw();
          delete box.dataset.pmDrawing;
          // As wide as its box; in the colours of the theme.
          let lastWidth = box.clientWidth;
          let frame = 0;
          const resized = new ResizeObserver(() => {
            if (Math.abs(box.clientWidth - lastWidth) < 1) return;
            lastWidth = box.clientWidth;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => void draw());
          });
          resized.observe(box);
          const theme = new MutationObserver(() => void draw());
          theme.observe(document.documentElement, { attributeFilter: ['data-theme', 'class'] });
          const setting = ctx.settings.onDidChange((key) => key === 'toolbar' && void draw());
          const scheme = matchMedia('(prefers-color-scheme: dark)');
          const onScheme = () => void draw();
          scheme.addEventListener('change', onScheme);
          // An exported page shows the figure as the picture it is now.
          box.dataset.pmSnapshot = '';
          (box as HTMLElement & { pmSnapshot?: () => Promise<string> }).pmSnapshot = () =>
            Plotly.toImage(box, {
              format: 'svg',
              width: box.clientWidth || 600,
              height: box.clientHeight || 400,
            });
          embed.register(() => {
            resized.disconnect();
            setting.dispose();
            theme.disconnect();
            scheme.removeEventListener('change', onScheme);
            cancelAnimationFrame(frame);
            Plotly.purge(box);
          });
        },
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
