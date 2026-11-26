import { describe, expect, it } from 'vitest';
import { figureSize, parseFigure, themedLayout } from '../src/figure';

const colors = { dark: true, text: '#eee', muted: '#999', grid: '#333', font: 'Inter' };

describe('Plotly figures', () => {
  it('reads what Plotly writes, and a list of traces', () => {
    const f = parseFigure('{"data":[{"y":[1,2]}],"layout":{"width":600,"height":300}}');
    expect(f.data).toHaveLength(1);
    expect(figureSize(f)).toEqual({ width: 600, height: 300 });
    expect(parseFigure('[{"y":[1]}]')).toEqual({ data: [{ y: [1] }], layout: {} });
    expect(() => parseFigure('{"layout":{}}')).toThrow(/no "data"/);
    expect(() => parseFigure('{')).toThrow(/not a Plotly figure/);
  });

  it('shows the app theme in place of the file one, keeping what the figure sets', () => {
    const layout = themedLayout(
      parseFigure(
        JSON.stringify({
          data: [],
          layout: {
            template: { layout: { paper_bgcolor: 'white' } },
            width: 700,
            title: { text: 'Loss' },
            xaxis: { title: { text: 'step' } },
            yaxis2: { gridcolor: 'red' },
          },
        }),
      ),
      colors,
    );
    expect(layout.template).toBeUndefined();
    expect(layout.width).toBeUndefined();
    expect(layout.paper_bgcolor).toBe('rgba(0,0,0,0)');
    expect(layout.font).toMatchObject({ color: '#eee', family: 'Inter' });
    expect(layout.xaxis).toMatchObject({ title: { text: 'step' }, gridcolor: '#333' });
    expect(layout.yaxis2).toMatchObject({ gridcolor: 'red', linecolor: '#333' });
    expect((layout.colorway as string[])[0]).toBe('#e3825a');
  });

  it('leaves the figure as it is, so the next theme is the next theme', () => {
    const figure = parseFigure('{"data":[],"layout":{"scene":{"xaxis":{"title":{"text":"x"}}}}}');
    const before = JSON.stringify(figure);
    const light = { ...colors, dark: false, grid: '#ddd' };
    themedLayout(figure, light);
    const dark = themedLayout(figure, colors);
    expect(JSON.stringify(figure)).toBe(before);
    expect((dark.scene as { xaxis: object }).xaxis).toMatchObject({
      gridcolor: '#333',
      title: { text: 'x' },
    });
  });
});
