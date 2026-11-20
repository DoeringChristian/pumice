/**
 * micromark syntax extensions for the Obsidian dialect (plus Pumice ID links, which share the
 * wikilink grammar). Each construct emits its own token types; `mdast.ts` turns them into nodes.
 */
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { markdownLineEnding, markdownLineEndingOrSpace } from 'micromark-util-character';
import { resolveAll } from 'micromark-util-resolve-all';
import type {
  Code,
  Construct,
  Event,
  Extension,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    wikiLink: 'wikiLink';
    wikiLinkEmbedMarker: 'wikiLinkEmbedMarker';
    wikiLinkMarker: 'wikiLinkMarker';
    wikiLinkContent: 'wikiLinkContent';
    highlight: 'highlight';
    highlightSequence: 'highlightSequence';
    highlightSequenceTemporary: 'highlightSequenceTemporary';
    highlightText: 'highlightText';
    tag: 'tag';
    blockId: 'blockId';
    comment: 'comment';
    commentFlow: 'commentFlow';
    commentData: 'commentData';
    inlineMathDollar: 'inlineMathDollar';
  }
}

const enum C {
  bang = 33,
  hash = 35,
  dollar = 36,
  percent = 37,
  equals = 61,
  bracketOpen = 91,
  backslash = 92,
  bracketClose = 93,
  caret = 94,
}

const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57;
const isWhitespaceOrStart = (code: Code) =>
  code === null || markdownLineEndingOrSpace(code) || code === 0xa0;

// ---------------------------------------------------------------------------------------------
// Wikilinks and embeds: [[target#sub|alias]], ![[target]]

const wikiLink: Construct = { name: 'wikiLink', tokenize: tokenizeWikiLink };

function tokenizeWikiLink(
  this: TokenizeContext,
  effects: Parameters<Tokenizer>[0],
  ok: State,
  nok: State,
): State {
  return start;

  function start(code: Code): State | undefined {
    effects.enter('wikiLink');
    if (code === C.bang) {
      effects.enter('wikiLinkEmbedMarker');
      effects.consume(code);
      effects.exit('wikiLinkEmbedMarker');
      return openFirst;
    }
    return openFirst(code);
  }

  function openFirst(code: Code): State | undefined {
    if (code !== C.bracketOpen) return nok(code);
    effects.enter('wikiLinkMarker');
    effects.consume(code);
    return openSecond;
  }

  function openSecond(code: Code): State | undefined {
    if (code !== C.bracketOpen) return nok(code);
    effects.consume(code);
    effects.exit('wikiLinkMarker');
    return contentStart;
  }

  function contentStart(code: Code): State | undefined {
    if (code === C.bracketClose || code === null || markdownLineEnding(code)) return nok(code);
    effects.enter('wikiLinkContent');
    return content(code);
  }

  function content(code: Code): State | undefined {
    if (code === null || markdownLineEnding(code) || code === C.bracketOpen) return nok(code);
    if (code === C.bracketClose) {
      effects.exit('wikiLinkContent');
      effects.enter('wikiLinkMarker');
      effects.consume(code);
      return close;
    }
    effects.consume(code);
    return code === C.backslash ? escaped : content;
  }

  function escaped(code: Code): State | undefined {
    if (code === null || markdownLineEnding(code)) return nok(code);
    effects.consume(code);
    return content;
  }

  function close(code: Code): State | undefined {
    if (code !== C.bracketClose) return nok(code);
    effects.consume(code);
    effects.exit('wikiLinkMarker');
    effects.exit('wikiLink');
    return ok;
  }
}

// ---------------------------------------------------------------------------------------------
// Highlights: ==text== (attention-like, so emphasis can nest inside; adapted from GFM
// strikethrough)

const highlight: Construct = {
  name: 'highlight',
  tokenize: tokenizeHighlight,
  resolveAll: resolveAllHighlight,
};

function tokenizeHighlight(
  this: TokenizeContext,
  effects: Parameters<Tokenizer>[0],
  ok: State,
  nok: State,
): State {
  const previous = this.previous;
  const events = this.events;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    if (previous === C.equals && events[events.length - 1]?.[1].type !== 'characterEscape') {
      return nok(code);
    }
    effects.enter('highlightSequenceTemporary');
    return more(code);
  }

  function more(code: Code): State | undefined {
    const before = classifyCharacter(previous);
    if (code === C.equals) {
      if (size > 1) return nok(code);
      effects.consume(code);
      size++;
      return more;
    }
    if (size < 2) return nok(code);
    const token = effects.exit('highlightSequenceTemporary');
    const after = classifyCharacter(code);
    token._open = !after || (after === 2 && Boolean(before));
    token._close = !before || (before === 2 && Boolean(after));
    return ok(code);
  }
}

function resolveAllHighlight(events: Event[], context: TokenizeContext): Event[] {
  let index = -1;
  while (++index < events.length) {
    const closeEvent = events[index]!;
    if (
      closeEvent[0] === 'enter' &&
      closeEvent[1].type === 'highlightSequenceTemporary' &&
      closeEvent[1]._close
    ) {
      let open = index;
      while (open--) {
        const openEvent = events[open]!;
        if (
          openEvent[0] === 'exit' &&
          openEvent[1].type === 'highlightSequenceTemporary' &&
          openEvent[1]._open
        ) {
          closeEvent[1].type = 'highlightSequence';
          openEvent[1].type = 'highlightSequence';
          const whole: Token = {
            type: 'highlight',
            start: { ...openEvent[1].start },
            end: { ...closeEvent[1].end },
          };
          const text: Token = {
            type: 'highlightText',
            start: { ...openEvent[1].end },
            end: { ...closeEvent[1].start },
          };
          const next: Event[] = [
            ['enter', whole, context],
            ['enter', openEvent[1], context],
            ['exit', openEvent[1], context],
            ['enter', text, context],
          ];
          const insideSpan = context.parser.constructs.insideSpan.null;
          if (insideSpan) {
            splice(
              next,
              next.length,
              0,
              resolveAll(insideSpan, events.slice(open + 1, index), context),
            );
          }
          splice(next, next.length, 0, [
            ['exit', text, context],
            ['enter', closeEvent[1], context],
            ['exit', closeEvent[1], context],
            ['exit', whole, context],
          ]);
          splice(events, open - 1, index - open + 3, next);
          index = open + next.length - 2;
          break;
        }
      }
    }
  }
  for (const event of events) {
    if (event[1].type === 'highlightSequenceTemporary') event[1].type = 'data';
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Tags: #tag, #nested/tag. Must follow whitespace or start a line, and contain a non-digit.

const TAG_CHAR = /[\p{L}\p{N}\p{M}_\-/‍]/u;
const isTagChar = (code: Code) =>
  code !== null &&
  code > 0 &&
  ((code >= 0xd800 && code <= 0xdfff) || TAG_CHAR.test(String.fromCharCode(code)));

const tag: Construct = { name: 'tag', tokenize: tokenizeTag };

function tokenizeTag(
  this: TokenizeContext,
  effects: Parameters<Tokenizer>[0],
  ok: State,
  nok: State,
): State {
  const previous = this.previous;
  let nonDigit = false;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    if (!isWhitespaceOrStart(previous)) return nok(code);
    effects.enter('tag');
    effects.consume(code);
    return body;
  }

  function body(code: Code): State | undefined {
    if (isTagChar(code)) {
      if (!isDigit(code)) nonDigit = true;
      size++;
      effects.consume(code);
      return body;
    }
    if (size === 0 || !nonDigit) return nok(code);
    effects.exit('tag');
    return ok(code);
  }
}

// ---------------------------------------------------------------------------------------------
// Block IDs: `^block-id` at the end of a line.

const blockId: Construct = { name: 'blockId', tokenize: tokenizeBlockId };

function tokenizeBlockId(
  this: TokenizeContext,
  effects: Parameters<Tokenizer>[0],
  ok: State,
  nok: State,
): State {
  const previous = this.previous;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    if (!isWhitespaceOrStart(previous)) return nok(code);
    effects.enter('blockId');
    effects.consume(code);
    return body;
  }

  function body(code: Code): State | undefined {
    if (code !== null && /[A-Za-z0-9-]/.test(String.fromCharCode(code))) {
      size++;
      effects.consume(code);
      return body;
    }
    if (size === 0 || !(code === null || markdownLineEnding(code))) return nok(code);
    effects.exit('blockId');
    return ok(code);
  }
}

// ---------------------------------------------------------------------------------------------
// Comments: %% inline %% and %% block %% (a block comment may span blank lines; an unclosed one
// runs to the end of the document, as in Obsidian).

const commentText: Construct = { name: 'comment', tokenize: tokenizeComment(false) };
const commentFlow: Construct = {
  name: 'commentFlow',
  tokenize: tokenizeComment(true),
  concrete: true,
};

function tokenizeComment(flow: boolean): Tokenizer {
  return function (effects, ok, nok) {
    const type = flow ? 'commentFlow' : 'comment';
    let closing = 0;
    let inData = false;
    return start;

    function data(code: Code): void {
      if (!inData) effects.enter('commentData');
      inData = true;
      effects.consume(code);
    }

    function endData(): void {
      if (inData) effects.exit('commentData');
      inData = false;
    }

    function start(code: Code): State | undefined {
      if (code !== C.percent) return nok(code);
      effects.enter(type);
      effects.consume(code);
      return second;
    }

    function second(code: Code): State | undefined {
      if (code !== C.percent) return nok(code);
      effects.consume(code);
      return inside;
    }

    function inside(code: Code): State | undefined {
      if (code === null) {
        if (!flow) return nok(code);
        endData();
        effects.exit(type);
        return ok(code);
      }
      if (markdownLineEnding(code)) {
        endData();
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        closing = 0;
        return inside;
      }
      data(code);
      if (code !== C.percent) {
        closing = 0;
        return inside;
      }
      closing++;
      if (closing < 2) return inside;
      endData();
      return flow ? after : done;
    }

    function done(code: Code): State | undefined {
      effects.exit(type);
      return ok(code);
    }

    // Only a block comment if nothing but whitespace follows the closing `%%` on its line;
    // otherwise this is a paragraph with an inline comment.
    function after(code: Code): State | undefined {
      if (code === 32 || code === 9 || code === -1 || code === -2) {
        effects.enter('whitespace');
        effects.consume(code);
        effects.exit('whitespace');
        return after;
      }
      if (code === null || markdownLineEnding(code)) return done(code);
      return nok(code);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Inline math with Obsidian's rules: `$x$` needs non-space right inside both dollars and no
// digit right after the closing one (so "$5 and $10" stays text); `$$x$$` inline is display math.

const inlineMath: Construct = { name: 'inlineMathDollar', tokenize: tokenizeInlineMath };

function tokenizeInlineMath(
  this: TokenizeContext,
  effects: Parameters<Tokenizer>[0],
  ok: State,
  nok: State,
): State {
  const previous = this.previous;
  let double = false;
  let last: Code = null;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    if (previous === C.dollar) return nok(code);
    effects.enter('inlineMathDollar');
    effects.consume(code);
    return open;
  }

  function open(code: Code): State | undefined {
    if (code === C.dollar) {
      double = true;
      effects.consume(code);
      return first;
    }
    return first(code);
  }

  function first(code: Code): State | undefined {
    if (code === null || code === C.dollar) return nok(code);
    if (!double && markdownLineEndingOrSpace(code)) return nok(code);
    return inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (markdownLineEnding(code)) {
      if (!double) return nok(code);
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      last = code;
      return inside;
    }
    if (code === C.dollar) {
      if (!double && (last === null || markdownLineEndingOrSpace(last))) return nok(code);
      effects.consume(code);
      return double ? closeSecond : afterClose;
    }
    effects.consume(code);
    size++;
    last = code;
    return code === C.backslash ? escaped : inside;
  }

  function escaped(code: Code): State | undefined {
    if (code === null || markdownLineEnding(code)) return inside(code);
    effects.consume(code);
    last = code;
    return inside;
  }

  function closeSecond(code: Code): State | undefined {
    if (code !== C.dollar) {
      // A single `$` inside display math is content.
      last = C.dollar;
      return inside(code);
    }
    effects.consume(code);
    return afterClose;
  }

  function afterClose(code: Code): State | undefined {
    if (!double && isDigit(code)) return nok(code);
    if (size === 0) return nok(code);
    effects.exit('inlineMathDollar');
    return ok(code);
  }
}

/** The dialect's micromark extension (use together with GFM, frontmatter and math flow). */
export function obsidianSyntax(): Extension {
  return {
    flow: { [C.percent]: commentFlow },
    text: {
      [C.bracketOpen]: wikiLink,
      [C.bang]: wikiLink,
      [C.equals]: highlight,
      [C.hash]: tag,
      [C.caret]: blockId,
      [C.percent]: commentText,
      [C.dollar]: inlineMath,
    },
    insideSpan: { null: [highlight] },
    attentionMarkers: { null: [C.equals] },
  };
}
