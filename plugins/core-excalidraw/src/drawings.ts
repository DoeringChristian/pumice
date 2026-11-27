import type { DrawingsApi, VaultPath } from '@pumice/api';
import {
  applyDrawingOps,
  describeDrawing,
  estimateText,
  type DrawingOp,
  type MeasureText,
} from './agent';
import { isDrawingPath, newDrawing, parseDrawing, serializeDrawing } from './format';

/**
 * Drawings read and changed as text, for assistants (the tools in core.agents' vault-tools.ts):
 * the same in a window and on a server. A picture needs the drawing library on a page: without
 * one (`picture` absent) there is none.
 */
export function textDrawings(
  measureText: MeasureText = estimateText,
  picture?: (path: VaultPath, text: string) => Promise<string>,
): DrawingsApi {
  return {
    isDrawing: isDrawingPath,
    describe(path, text) {
      const drawing = parseDrawing(path, text);
      return describeDrawing(drawing.scene, drawing.embedded);
    },
    edit(path, text, operations, options) {
      if (!isDrawingPath(path)) throw new Error('A drawing is a file that ends in ".excalidraw".');
      const drawing = parseDrawing(path, text ?? newDrawing(path));
      const summary = applyDrawingOps(
        drawing.scene,
        operations as DrawingOp[],
        measureText,
        options,
      );
      return { text: serializeDrawing(drawing), summary };
    },
    picture: picture ?? (() => Promise.reject(new Error('No pictures of drawings here.'))),
  };
}
