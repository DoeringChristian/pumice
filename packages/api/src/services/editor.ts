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

export interface EditorApi {
  /** Adds a button to the editing toolbar shown above the keyboard on phones and tablets. */
  registerToolbarAction(action: EditorToolbarAction): Disposable;
  /** Adds an item to the editor's right-click menu. */
  registerContextMenuItem(item: EditorContextMenuItem): Disposable;
  /** Adds a CodeMirror extension to every markdown editor (existing and future ones). */
  registerExtension(factory: (ctx: EditorExtensionContext) => Extension): Disposable;
  /** The editor of the active tab, if it is a markdown editor in editing mode. */
  active(): { path: VaultPath; view: EditorView } | undefined;
  /** Replaces the selection of the active editor (inserts at the cursor). Returns false if none. */
  insertAtCursor(text: string): boolean;
}

export const Editor = defineService<EditorApi>('core.editor');
