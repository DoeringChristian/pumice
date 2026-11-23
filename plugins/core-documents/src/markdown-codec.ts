import { ORIGIN_EXTERNAL_FILE, markdownText, type DocumentCodec } from '@pumice/api';
import type * as Y from 'yjs';
import { applyTextDiff, merge3 } from './merge';

/** Line endings are normalized to LF inside the document and restored on save. */
function eolOf(doc: Y.Doc): string {
  return (doc.getMap('file').get('eol') as string | undefined) ?? '\n';
}

function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function fromLf(text: string, eol: string): string {
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/** More than this is not opened for editing. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Whether the bytes of a file are text that can be edited and written back unchanged: UTF-8,
 * without the zero bytes of a binary file. Returns why not, if not.
 */
export function notText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > MAX_TEXT_BYTES) return 'it is too large to edit here';
  if (bytes.subarray(0, 8192).includes(0)) return 'it is not a text file';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return undefined;
  } catch {
    return 'it is not text in UTF-8';
  }
}

export const markdownCodec: DocumentCodec = {
  id: 'markdown',
  extensions: ['md', 'markdown', 'txt'],
  load(doc, content) {
    doc.transact(() => {
      if (content.includes('\r\n')) doc.getMap('file').set('eol', '\r\n');
      markdownText(doc).insert(0, toLf(content));
    }, ORIGIN_EXTERNAL_FILE);
  },
  serialize(doc) {
    return fromLf(markdownText(doc).toString(), eolOf(doc));
  },
  mergeExternal(doc, base, theirs) {
    const text = markdownText(doc);
    const result = merge3(toLf(base), text.toString(), toLf(theirs));
    if (!result.clean) return false;
    doc.transact(() => applyTextDiff(text, result.text), ORIGIN_EXTERNAL_FILE);
    return true;
  },
};

/**
 * Any other file that holds text (a .tex, a .json, a script, …): edited as the text it is.
 * Used for files no codec is registered for, once their content was found to be text.
 */
export const textCodec: DocumentCodec = { ...markdownCodec, id: 'text', extensions: [] };
