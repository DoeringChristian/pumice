/**
 * A Plotly figure as the app shows it: the figure's own data and layout, in the colours and
 * fonts of the app (light or dark), and as wide as the box it is in.
 */

/** Colours of data series, in the order they are used (the same as in frames). */
export const SERIES = {
  light: ['#c8582e', '#2f7f8f', '#7a8f3a', '#8a5aa8', '#c9952b', '#5b6f9e'],
  dark: ['#e3825a', '#5fb3c4', '#a9bf63', '#b58ad1', '#e0b354', '#8ea3d6'],
};

export interface Figure {
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
  frames?: unknown[];
}

/** The figure in a file (what `fig.write_json` or `fig.to_json` writes). */
export function parseFigure(text: string): Figure {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`This is not a Plotly figure: ${e instanceof Error ? e.message : e}`);
  }
  const v = value as Partial<Figure> | unknown[] | null;
  // A list of traces alone is a figure too.
  if (Array.isArray(v)) return { data: v as Record<string, unknown>[], layout: {} };
  if (!v || typeof v !== 'object' || !Array.isArray(v.data))
    throw new Error('This is not a Plotly figure: it has no "data" list.');
  return {
    data: v.data,
    layout: v.layout && typeof v.layout === 'object' ? { ...v.layout } : {},
    ...(Array.isArray(v.frames) ? { frames: v.frames } : {}),
  };
}

/** How large the figure asks to be, where it says so. */
export function figureSize(figure: Figure): { width: number; height: number } | undefined {
  const { width, height } = figure.layout;
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

export interface Colors {
  dark: boolean;
  text: string;
  muted: string;
  grid: string;
  font: string;
}

const AXIS = /^(xaxis|yaxis|zaxis)\d*$/;

/**
 * The layout as shown: the theme the file names (Plotly's white one, mostly) gives way to the
 * app's; what the figure sets itself stays. Its width is that of its box.
 */
export function themedLayout(figure: Figure, c: Colors): Record<string, unknown> {
  const { template: _template, width: _width, ...own } = figure.layout;
  const axis = {
    gridcolor: c.grid,
    linecolor: c.grid,
    zerolinecolor: c.grid,
    tickcolor: c.grid,
    automargin: true,
  };
  const layout: Record<string, unknown> = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: c.font, color: c.text, size: 12 },
    colorway: c.dark ? SERIES.dark : SERIES.light,
    margin: { l: 48, r: 16, t: own.title ? 40 : 16, b: 40 },
    legend: { bgcolor: 'rgba(0,0,0,0)' },
    hoverlabel: { font: { family: c.font } },
    xaxis: axis,
    yaxis: axis,
    ...own,
    autosize: true,
  };
  // The figure's own axes, with the app's colours where it sets none.
  for (const key of Object.keys(layout))
    if (AXIS.test(key)) layout[key] = { ...axis, ...(layout[key] as object) };
  // (A scene of its own: the figure's stays as it is, for the next theme.)
  const own3d = layout.scene as Record<string, unknown> | undefined;
  if (own3d) {
    const scene: Record<string, unknown> = { ...own3d };
    for (const a of ['xaxis', 'yaxis', 'zaxis'])
      scene[a] = { gridcolor: c.grid, color: c.muted, ...(own3d[a] as object) };
    layout.scene = scene;
  }
  return layout;
}
