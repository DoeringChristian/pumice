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
