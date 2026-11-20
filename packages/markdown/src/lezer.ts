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
    for (; i < cx.end; i++) {
      const c = cx.char(i);
      if (c === 10 || c === 13 || c === 91) return -1;
      if (c === 92) {
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
    FootnoteReferenceParser,
    HighlightParser,
    TagParser,
    BlockIdParser,
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

/** Everything the editor needs: GFM (no sub/superscript, which Obsidian lacks) + the dialect. */
export const dialectExtensions: MarkdownConfig[] = [...GFM, ObsidianSyntax];
