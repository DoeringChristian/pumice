/**
 * Lezer (`@lezer/markdown`) extensions for the dialect. They mirror the micromark constructs in
 * `micromark.ts`; the conformance tests check that both parsers find the same semantic nodes.
 */
import type { Element } from '@lezer/markdown';
import {
  GFM,
  type BlockContext,
  type InlineContext,
  type Line,
  type MarkdownConfig,
} from '@lezer/markdown';
import { Tag, tags } from '@lezer/highlight';
import { citationKey } from './bibtex';
import { LABEL_NAME, REFERENCE_NAME } from './links';

/** Highlight tags for dialect nodes (use them in CodeMirror highlight styles). */
export const dialectTags = {
  wikiLink: Tag.define(tags.link),
  embed: Tag.define(tags.link),
  highlight: Tag.define(),
  tag: Tag.define(),
  blockId: Tag.define(),
  comment: Tag.define(tags.comment),
  math: Tag.define(tags.string),
};

const PUNCTUATION = /[\p{S}\p{P}]/u;
const TAG_CHAR = /[\p{L}\p{N}\p{M}_\-/‍]/u;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c < 0;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isTagChar = (c: number) =>
  c > 0 && ((c >= 0xd800 && c <= 0xdfff) || TAG_CHAR.test(String.fromCharCode(c)));
/** Whether position `pos` starts a "word": start of the inline section or after whitespace. */
const atWordStart = (cx: InlineContext, pos: number) =>
  pos === cx.offset || isSpace(cx.char(pos - 1));

const WikiLinkParser = {
  name: 'WikiLink',
  before: 'Link',
  parse(cx: InlineContext, next: number, pos: number): number {
    const start = pos;
    const children: Element[] = [];
    if (next === 33) {
      if (cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
      children.push(cx.elt('EmbedMark', pos, pos + 1));
      pos++;
    } else if (next !== 91 || cx.char(pos + 1) !== 91) {
      return -1;
    }
    const contentFrom = pos + 2;
    if (cx.char(contentFrom) === 93) return -1;
    let i = contentFrom;
    // The caption of an embed may refer to something: `![[a.png|As in [[#^fig-b]]]]`.
    let piped = false;
    for (; i < cx.end; i++) {
      const c = cx.char(i);
      if (c === 10 || c === 13) return -1;
      if (c === 124) piped = true;
      if (c === 91) {
        if (start === pos || !piped || cx.char(i + 1) !== 91) return -1;
        let j = i + 2;
        for (; j < cx.end; j++) {
          const d = cx.char(j);
          if (d === 10 || d === 13 || d === 91) return -1;
          if (d === 93) break;
        }
        if (j === i + 2 || cx.char(j + 1) !== 93) return -1;
        i = j + 1;
        continue;
      }
      if (c === 92) {
        if (cx.char(i + 1) === 124) piped = true;
        if (cx.char(i + 1) === 10 || i + 1 >= cx.end) return -1;
        i++;
        continue;
      }
      if (c === 93) {
        if (cx.char(i + 1) !== 93) return -1;
        break;
      }
    }
    if (i >= cx.end) return -1;
    const content = cx.slice(contentFrom, i);
    children.push(cx.elt('WikiLinkMark', pos, contentFrom));
    const pipe = /\\?\|/.exec(content);
    const mainTo = pipe ? contentFrom + pipe.index : i;
    const hash = content.slice(0, mainTo - contentFrom).indexOf('#');
    const targetTo = hash >= 0 ? contentFrom + hash : mainTo;
    if (targetTo > contentFrom) children.push(cx.elt('WikiLinkTarget', contentFrom, targetTo));
    if (hash >= 0) children.push(cx.elt('WikiLinkSubpath', targetTo, mainTo));
    if (pipe) {
      const aliasFrom = mainTo + pipe[0].length;
      children.push(cx.elt('WikiLinkPipe', mainTo, aliasFrom));
      if (aliasFrom < i) children.push(cx.elt('WikiLinkAlias', aliasFrom, i));
    }
    children.push(cx.elt('WikiLinkMark', i, i + 2));
    return cx.addElement(cx.elt(start === pos ? 'WikiLink' : 'Embed', start, i + 2, children));
  },
};

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

const HighlightParser = {
  name: 'Highlight',
  after: 'Emphasis',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
    if (cx.char(pos - 1) === 61) return -1;
    const before = cx.slice(pos - 1, pos);
    const after = cx.slice(pos + 2, pos + 3);
    const sBefore = /\s|^$/.test(before);
    const sAfter = /\s|^$/.test(after);
    const pBefore = PUNCTUATION.test(before);
    const pAfter = PUNCTUATION.test(after);
    return cx.addDelimiter(
      HighlightDelim,
      pos,
      pos + 2,
      !sAfter && (!pAfter || sBefore || pBefore),
      !sBefore && (!pBefore || sAfter || pAfter),
    );
  },
};

const isNameChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** What a citation key is made of: letters, digits, `_`, and `: . + / -` inside it. */
const isKeyChar = (c: number) =>
  isNameChar(c) || c === 95 || c === 58 || c === 46 || c === 43 || c === 47 || c === 45;

/**
 * `@fig-loss`: a reference to a figure, table or equation of the note. `@doe2020`: a citation
 * of an entry of the bibliography (as in pandoc; in brackets too: `[@doe2020, p. 3]`).
 */
const ReferenceParser = {
  name: 'Reference',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (
      next !== 64 ||
      (pos > cx.offset && (isNameChar(cx.char(pos - 1)) || cx.char(pos - 1) === 64))
    )
      return -1;
    let i = pos + 1;
    while (i < cx.end && isKeyChar(cx.char(i))) i++;
    // Without the punctuation of the sentence behind it.
    const name = citationKey(cx.slice(pos + 1, i));
    if (!name) return -1;
    // A figure, table or equation of the note; anything else may be a key of the bibliography.
    return cx.addElement(
      cx.elt(REFERENCE_NAME.test(name) ? 'Reference' : 'Citation', pos, pos + 1 + name.length),
    );
  },
};

const TagParser = {
  name: 'Tag',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== 35 || !atWordStart(cx, pos)) return -1;
    let i = pos + 1;
    let nonDigit = false;
    while (i < cx.end && isTagChar(cx.char(i))) {
      if (!isDigit(cx.char(i))) nonDigit = true;
      i++;
    }
    if (i === pos + 1 || !nonDigit) return -1;
    return cx.addElement(cx.elt('Tag', pos, i, [cx.elt('TagMark', pos, pos + 1)]));
  },
};

const BlockIdParser = {
  name: 'BlockId',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== 94 || !atWordStart(cx, pos)) return -1;
    let i = pos + 1;
    while (i < cx.end && /[A-Za-z0-9-]/.test(String.fromCharCode(cx.char(i)))) i++;
    if (i === pos + 1) return -1;
    if (i < cx.end && cx.char(i) !== 10 && cx.char(i) !== 13) return -1;
    return cx.addElement(cx.elt('BlockId', pos, i));
  },
};

/** `{#fig-loss}`: the label of what stands before it (a figure, a table's caption, an equation). */
const LabelParser = {
  name: 'Label',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== 123 || cx.char(pos + 1) !== 35) return -1;
    let i = pos + 2;
    while (i < cx.end && (isNameChar(cx.char(i)) || cx.char(i) === 45)) i++;
    if (cx.char(i) !== 125 || !LABEL_NAME.test(cx.slice(pos + 2, i))) return -1;
    return cx.addElement(cx.elt('BlockId', pos, i + 1));
  },
};

const CommentParser = {
  name: 'Comment',
  before: 'Emphasis',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
    const close = cx.slice(pos + 2, cx.end).indexOf('%%');
    if (close < 0) return -1;
    const end = pos + 2 + close + 2;
    return cx.addElement(
      cx.elt('Comment', pos, end, [
        cx.elt('CommentMark', pos, pos + 2),
        cx.elt('CommentMark', end - 2, end),
      ]),
    );
  },
};

const InlineMathParser = {
  name: 'InlineMath',
  before: 'Escape',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== 36 || cx.char(pos - 1) === 36) return -1;
    const double = cx.char(pos + 1) === 36;
    let i = pos + (double ? 2 : 1);
    if (i >= cx.end || cx.char(i) === 36) return -1;
    if (!double && isSpace(cx.char(i))) return -1;
    let last = -1;
    let end = -1;
    for (; i < cx.end; i++) {
      const c = cx.char(i);
      if (c === 10 || c === 13) {
        if (!double) return -1;
        last = c;
        continue;
      }
      if (c === 92) {
        if (i + 1 < cx.end && cx.char(i + 1) !== 10) i++;
        last = cx.char(i);
        continue;
      }
      if (c === 36) {
        if (double) {
          if (cx.char(i + 1) === 36) {
            end = i + 2;
            break;
          }
          last = c;
          continue;
        }
        if (last < 0 || isSpace(last)) return -1;
        if (isDigit(cx.char(i + 1))) return -1;
        end = i + 1;
        break;
      }
      last = c;
    }
    if (end < 0) return -1;
    const markLen = double ? 2 : 1;
    return cx.addElement(
      cx.elt(double ? 'InlineMathDisplay' : 'InlineMath', pos, end, [
        cx.elt('MathMark', pos, pos + markLen),
        cx.elt('MathMark', end - markLen, end),
      ]),
    );
  },
};

const FootnoteReferenceParser = {
  name: 'FootnoteReference',
  before: 'Link',
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== 91 || cx.char(pos + 1) !== 94) return -1;
    const m = /^\[\^([^\]\s]+)\]/.exec(cx.slice(pos, Math.min(cx.end, pos + 200)));
    if (!m || cx.char(pos + m[0].length) === 58) return -1;
    return cx.addElement(cx.elt('FootnoteReference', pos, pos + m[0].length));
  },
};

/** How many containers the current line continues (internal to Lezer, used like FencedCode). */
const lineDepth = (line: Line) => (line as unknown as { depth: number }).depth;

/** Adds the container markers (`>` of blockquotes) of the current line to `marks`. */
function pushMarkers(line: Line, marks: Element[]): void {
  for (const m of (line as unknown as { markers: Element[] }).markers) marks.push(m);
}

function parseMathBlock(cx: BlockContext, line: Line): boolean {
  if (line.next !== 36 || line.text.charCodeAt(line.pos + 1) !== 36) return false;
  if (line.indent - line.baseIndent >= 4) return false;
  let len = 2;
  while (line.text.charCodeAt(line.pos + len) === 36) len++;
  // `$$x$$` on one line is inline display math in a paragraph (as in micromark).
  if (line.text.slice(line.pos + len).includes('$')) return false;
  // Only a block once it is closed: a `$$` that was just typed must not turn the rest of the
  // note into a formula. (Block parsers cannot rewind, so the raw input is looked at.)
  const input = (
    cx as unknown as { input: { length: number; read(from: number, to: number): string } }
  ).input;
  const after = cx.lineStart + line.text.length;
  const rest = input.read(after, Math.min(input.length, after + 20000));
  if (!/\n[ \t>]*\${2,}[ \t]*(?:\r?\n|$)/.test(rest)) return false;
  const from = cx.lineStart + line.pos;
  const marks: Element[] = [cx.elt('MathMark', from, from + len)];
  const depth = cx.depth;
  while (cx.nextLine() && lineDepth(line) >= depth) {
    pushMarkers(line, marks);
    let i = line.pos;
    while (line.text.charCodeAt(i) === 36) i++;
    if (i - line.pos >= len && line.skipSpace(i) === line.text.length) {
      marks.push(cx.elt('MathMark', cx.lineStart + line.pos, cx.lineStart + i));
      cx.nextLine();
      break;
    }
  }
  cx.addElement(cx.elt('MathBlock', from, cx.prevLineEnd(), marks));
  return true;
}

function parseCommentBlock(cx: BlockContext, line: Line): boolean {
  if (line.next !== 37 || line.text.charCodeAt(line.pos + 1) !== 37) return false;
  const from = cx.lineStart + line.pos;
  const firstClose = line.text.indexOf('%%', line.pos + 2);
  // Closed on the first line with text after it: a paragraph with an inline comment.
  if (firstClose >= 0 && line.text.slice(firstClose + 2).trim() !== '') return false;
  const marks: Element[] = [cx.elt('CommentMark', from, from + 2)];
  if (firstClose >= 0) {
    marks.push(cx.elt('CommentMark', cx.lineStart + firstClose, cx.lineStart + firstClose + 2));
    cx.nextLine();
  } else {
    const depth = cx.depth;
    while (cx.nextLine() && lineDepth(line) >= depth) {
      pushMarkers(line, marks);
      const close = line.text.indexOf('%%', line.basePos);
      if (close >= 0) {
        marks.push(cx.elt('CommentMark', cx.lineStart + close, cx.lineStart + close + 2));
        cx.nextLine();
        break;
      }
    }
  }
  cx.addElement(cx.elt('CommentBlock', from, cx.prevLineEnd(), marks));
  return true;
}

/** The dialect's inline and block syntax (without frontmatter, which editors handle separately). */
export const ObsidianSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: { 'WikiLink/...': dialectTags.wikiLink } },
    { name: 'Embed', style: { 'Embed/...': dialectTags.embed } },
    { name: 'EmbedMark', style: tags.processingInstruction },
    { name: 'WikiLinkMark', style: tags.processingInstruction },
    'WikiLinkTarget',
    'WikiLinkSubpath',
    { name: 'WikiLinkPipe', style: tags.processingInstruction },
    'WikiLinkAlias',
    { name: 'Highlight', style: { 'Highlight/...': dialectTags.highlight } },
    { name: 'HighlightMark', style: tags.processingInstruction },
    { name: 'Tag', style: dialectTags.tag },
    'TagMark',
    { name: 'BlockId', style: dialectTags.blockId },
    { name: 'Reference', style: dialectTags.wikiLink },
    'Citation',
    { name: 'Comment', style: dialectTags.comment },
    { name: 'CommentBlock', block: true, style: dialectTags.comment },
    { name: 'CommentMark', style: tags.processingInstruction },
    { name: 'InlineMath', style: dialectTags.math },
    { name: 'InlineMathDisplay', style: dialectTags.math },
    { name: 'MathBlock', block: true, style: dialectTags.math },
    { name: 'MathMark', style: tags.processingInstruction },
    { name: 'FootnoteReference', style: tags.labelName },
  ],
  parseInline: [
    WikiLinkParser,
    ReferenceParser,
    FootnoteReferenceParser,
    HighlightParser,
    TagParser,
    BlockIdParser,
    LabelParser,
    CommentParser,
    InlineMathParser,
  ],
  parseBlock: [
    { name: 'MathBlock', parse: parseMathBlock, before: 'FencedCode' },
    { name: 'CommentBlock', parse: parseCommentBlock, before: 'FencedCode' },
  ],
};

/** YAML frontmatter at the very start of the document (for non-editor uses of the Lezer parser). */
export const FrontmatterSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true }, 'FrontmatterMark'],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text !== '---') return false;
        // Only a frontmatter block if it's closed (micromark agrees); peek at the raw input
        // because block parsers can't rewind.
        const input = (
          cx as unknown as { input: { length: number; read(from: number, to: number): string } }
        ).input;
        if (!/\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(input.read(0, input.length))) return false;
        const marks: Element[] = [cx.elt('FrontmatterMark', 0, 3)];
        while (cx.nextLine()) {
          if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) {
            marks.push(cx.elt('FrontmatterMark', cx.lineStart, cx.lineStart + 3));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};

/**
 * A table ends at the first line without a `|`: text written right under a table is a
 * paragraph, not one more row of it (as GFM would have it). Mirrored in `mdast.ts`.
 */
const TableEndsAtText: MarkdownConfig = {
  parseBlock: [
    {
      name: 'TableEndsAtText',
      endLeaf(_cx, line, leaf) {
        const inTable = leaf.parsers.some((p) => Array.isArray((p as { rows?: unknown }).rows));
        return inTable && !line.text.slice(line.pos).includes('|');
      },
    },
  ],
};

/** Everything the editor needs: GFM (no sub/superscript, which Obsidian lacks) + the dialect. */
export const dialectExtensions: MarkdownConfig[] = [...GFM, TableEndsAtText, ObsidianSyntax];
