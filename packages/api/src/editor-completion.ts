import type { CompletionSource } from '@codemirror/autocomplete';
import { Facet } from '@codemirror/state';

/**
 * Suggestions while typing in the markdown editor. A plugin adds a source with
 * `Editor.registerExtension(() => editorCompletions.of(source))`; the editor asks the sources
 * in order and shows the suggestions of the first that has any (use `Prec.high` to be asked
 * before the others).
 */
export const editorCompletions = Facet.define<CompletionSource>();
