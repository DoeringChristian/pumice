/** What is used of Plotly (its package has no types). */
declare module 'plotly.js-strict-dist-min' {
  export function react(
    el: HTMLElement,
    data: unknown[],
    layout: unknown,
    config?: unknown,
  ): Promise<HTMLElement>;
  export function purge(el: HTMLElement): void;
  export function toImage(
    el: HTMLElement,
    opts: { format: 'svg' | 'png'; width: number; height: number },
  ): Promise<string>;
}
