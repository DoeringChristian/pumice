import { isMap, parseDocument, type Document } from 'yaml';

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface FrontmatterBounds {
  /** Whole block including fences and the line ending after the closing fence. */
  from: number;
  to: number;
  /** The YAML between the fences. */
  contentFrom: number;
  contentTo: number;
}

const FRONTMATTER = /^---[ \t]*(\r?\n)([\s\S]*?)(?:^|\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

export function frontmatterBounds(text: string): FrontmatterBounds | undefined {
  if (!text.startsWith('---')) return undefined;
  const m = FRONTMATTER.exec(text);
  if (!m || m.index !== 0) return undefined;
  const contentFrom = m[0].indexOf(m[1]!) + m[1]!.length;
  return { from: 0, to: m[0].length, contentFrom, contentTo: contentFrom + m[2]!.length };
}

/**
 * Edits the frontmatter through yaml's Document API, which keeps comments, key order and
 * formatting of untouched entries. Creates the block when missing. Returns null if the YAML is
 * invalid (the caller should not touch it) or nothing changed.
 */
export function updateFrontmatter(
  text: string,
  update: (doc: Document) => void,
): TextChange | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const bounds = frontmatterBounds(text);
  const source = bounds ? text.slice(bounds.contentFrom, bounds.contentTo) : '';
  const doc = parseDocument(source, { keepSourceTokens: true });
  if (doc.errors.length) return null;
  if (!isMap(doc.contents)) {
    if (doc.contents !== null && source.trim() !== '') return null;
    doc.contents = doc.createNode({}) as never;
  }
  update(doc);
  let yaml = doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  if (yaml === '{}') yaml = '';
  if (eol === '\r\n') yaml = yaml.replace(/\r?\n/g, '\r\n');
  if (bounds) {
    if (yaml === source) return null;
    return { from: bounds.contentFrom, to: bounds.contentTo, insert: yaml };
  }
  if (!yaml) return null;
  return { from: 0, to: 0, insert: `---${eol}${yaml}${eol}---${eol}` };
}

export function setProperty(text: string, key: string, value: unknown): TextChange | null {
  return updateFrontmatter(text, (doc) => doc.set(key, value));
}

export function deleteProperty(text: string, key: string): TextChange | null {
  return updateFrontmatter(text, (doc) => {
    doc.delete(key);
  });
}

export function applyChange(text: string, change: TextChange | null): string {
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}
