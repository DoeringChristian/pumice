import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { VaultPath } from '@pumice/platform';
import type { Disposable } from '../lifecycle';
import { defineService } from '../service';

export interface EditorExtensionContext {
  /** Path of the file the editor shows, if any. */
  path(): VaultPath | undefined;
  /** Whether the editor shows raw markdown (source mode) instead of live preview. */
  sourceMode(): boolean;
}

export interface EditorToolbarAction {
  id: string;
  title: string;
  /** Icon name (see `@pumice/ui`) or a short text label. */
  icon: string;
  order?: number;
  run(view: EditorView): void;
}

export interface EditorContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  /** Lower comes first; built-in clipboard items use 0–9. */
  order?: number;
  /** Shown only when this returns true (default: always). */
  when?(view: EditorView, path: VaultPath): boolean;
  run(view: EditorView, path: VaultPath): unknown;
}

/** A figure's caption as it is shown in an editor (see `Editor.captions`). */
export interface EditorCaption {
  text: string;
  element: HTMLElement;
  /** Where the figure stands in the note. */
  from: number;
  to: number;
  /** Starts writing the caption, the cursor at `offset` in its text. */
  edit(offset: number): void;
}

export interface EditorApi {
  /** Adds a button to the editing toolbar shown above the keyboard on phones and tablets. */
  registerToolbarAction(action: EditorToolbarAction): Disposable;
  /** Adds an item to the editor's right-click menu. */
  registerContextMenuItem(item: EditorContextMenuItem): Disposable;
  /** Adds a CodeMirror extension to every markdown editor (existing and future ones). */
  registerExtension(factory: (ctx: EditorExtensionContext) => Extension): Disposable;
  /**
   * Adds a CodeMirror extension to the small text fields the editor shows inside a note (a
   * figure's caption while it is written): for key bindings that should hold there as in the
   * note itself (vim mode). With such an extension the field is an editor of its own.
   */
  registerFieldExtension(factory: () => Extension): Disposable;
  /**
   * If a figure's caption is what lies above (-1) or below (1) the cursor of `view` (or, above
   * the first row of the note, its name), starts writing it and returns true. For key bindings that move the cursor themselves (vim mode);
   * the arrow keys do this on their own.
   */
  enterCaptionFrom(view: EditorView, dir: -1 | 1): boolean;
  /**
   * The captions of the figures shown in `view` that can be written: their text, the element
   * it stands in, the figure's place in the note, and a way to start writing with the cursor
   * at a place in the text. For key bindings that jump to text on screen (vim mode's leap).
   */
  captions(view: EditorView): EditorCaption[];
  /** The editor of the active tab, if it is a markdown editor in editing mode. */
  active(): { path: VaultPath; view: EditorView } | undefined;
  /** Replaces the selection of the active editor (inserts at the cursor). Returns false if none. */
  insertAtCursor(text: string): boolean;
}

export const Editor = defineService<EditorApi>('core.editor');
