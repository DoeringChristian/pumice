import { Remembered } from '@pumice/api';

/**
 * How high things were when they were last drawn (embeds, frames, diagrams), remembered on this
 * device: a note that is opened has its length at once, and nothing moves while they load. With
 * the width of the text they were drawn in: at another, they are of other heights.
 */
export const drawnHeights = new Remembered<{ height: number; width: number }>(
  (a, b) => a.height === b.height && a.width === b.width,
);

/** The height something has in a text of this width, if it was drawn at that. */
export function heightAt(key: string, width: number): number | undefined {
  const found = drawnHeights.get(key);
  return found && Math.abs(found.width - width) <= 2 ? found.height : undefined;
}
