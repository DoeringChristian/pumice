import type {
  Blockquote,
  BlockContent,
  DefinitionContent,
  Paragraph,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast';
import { fromMarkdown, type Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import type { Extension as MicromarkExtension } from 'micromark-util-types';
import { CALLOUT_MARKER, parseWikiLinkContent } from './links';
import { obsidianSyntax } from './micromark';

export interface WikiLink {
  type: 'wikiLink';
  embed: boolean;
  /** Raw source, e.g. `![[img.png|300]]`. */
  raw: string;
  target: string;
  subpath?: string;
  alias?: string;
  position?: Root['position'];
  data?: Record<string, unknown>;
}

export interface Highlight extends Parent {
  type: 'highlight';
  children: PhrasingContent[];
}

export interface Tag {
  type: 'tag';
  /** Without `#`. */
  value: string;
  position?: Root['position'];
  data?: Record<string, unknown>;
}

export interface BlockId {
  type: 'blockId';
  /** Without `^`. */
  value: string;
  position?: Root['position'];
  data?: Record<string, unknown>;
}

export interface Comment {
  type: 'comment';
  value: string;
  block: boolean;
  position?: Root['position'];
  data?: Record<string, unknown>;
}

export interface Callout extends Parent {
  type: 'callout';
  calloutType: string;
  /** `+` expanded, `-` collapsed, undefined: not foldable. */
  fold?: '+' | '-';
  title: PhrasingContent[];
  children: Array<BlockContent | DefinitionContent>;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLink;
    highlight: Highlight;
    tag: Tag;
    blockId: BlockId;
    comment: Comment;
  }
  interface BlockContentMap {
    callout: Callout;
    comment: Comment;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
    highlight: Highlight;
    tag: Tag;
    blockId: BlockId;
    comment: Comment;
    callout: Callout;
  }
}

const dialectFromMarkdown: FromMarkdownExtension = {
  enter: {
    wikiLink(token) {
      const raw = this.sliceSerialize(token);
      this.enter({ type: 'wikiLink', embed: raw.startsWith('!'), raw, target: '' } as never, token);
    },
    wikiLinkContent(token) {
      const node = this.stack[this.stack.length - 1] as unknown as WikiLink;
      Object.assign(node, parseWikiLinkContent(this.sliceSerialize(token)));
    },
    highlight(token) {
      this.enter({ type: 'highlight', children: [] } as never, token);
    },
    tag(token) {
      this.enter({ type: 'tag', value: this.sliceSerialize(token).slice(1) } as never, token);
    },
    blockId(token) {
      this.enter({ type: 'blockId', value: this.sliceSerialize(token).slice(1) } as never, token);
    },
    comment(token) {
      const raw = this.sliceSerialize(token);
      this.enter({ type: 'comment', block: false, value: raw.slice(2, -2) } as never, token);
    },
    commentFlow(token) {
      const raw = this.sliceSerialize(token).trimEnd();
      const value = raw.endsWith('%%') && raw.length >= 4 ? raw.slice(2, -2) : raw.slice(2);
      this.enter({ type: 'comment', block: true, value } as never, token);
    },
    inlineMathDollar(token) {
      const raw = this.sliceSerialize(token);
      const double = raw.startsWith('$$');
      const value = double ? raw.slice(2, -2) : raw.slice(1, -1);
      this.enter(
        {
          type: 'inlineMath',
          value,
          data: {
            display: double,
            hName: 'code',
            hProperties: { className: ['language-math', double ? 'math-display' : 'math-inline'] },
            hChildren: [{ type: 'text', value }],
          },
        } as never,
        token,
      );
    },
  },
  exit: {
    wikiLink(token) {
      this.exit(token);
    },
    highlight(token) {
      this.exit(token);
    },
    tag(token) {
      this.exit(token);
    },
    blockId(token) {
      this.exit(token);
    },
    comment(token) {
      this.exit(token);
    },
    commentFlow(token) {
      this.exit(token);
    },
    inlineMathDollar(token) {
      this.exit(token);
    },
  },
};

export function micromarkExtensions(extra: MicromarkExtension[] = []): MicromarkExtension[] {
  // math(): only its `$$` flow construct; inline math uses Obsidian's rules from obsidianSyntax.
  const { flow } = math();
  return [frontmatter(['yaml']), gfm(), { flow: flow ?? {} }, obsidianSyntax(), ...extra];
}

export function mdastExtensions(extra: FromMarkdownExtension[] = []): FromMarkdownExtension[] {
  return [
    frontmatterFromMarkdown(['yaml']),
    ...gfmFromMarkdown(),
    mathFromMarkdown(),
    dialectFromMarkdown,
    ...extra,
  ];
}

export interface ParseOptions {
  micromark?: MicromarkExtension[];
  mdast?: FromMarkdownExtension[];
  /** Tree transforms run after parsing (e.g. plugin syntax post-processing). */
  transforms?: Array<(tree: Root) => void>;
}

/** Parses the full dialect into mdast. */
export function parseMarkdown(text: string, opts: ParseOptions = {}): Root {
  const tree = fromMarkdown(text, {
    extensions: micromarkExtensions(opts.micromark),
    mdastExtensions: mdastExtensions(opts.mdast),
  });
  transformCallouts(tree);
  for (const transform of opts.transforms ?? []) transform(tree);
  return tree;
}

/** Turns `> [!type] Title` blockquotes into `callout` nodes (recursively). */
export function transformCallouts(parent: Parent): void {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i] as RootContent;
    if ('children' in child) transformCallouts(child as Parent);
    if (child.type === 'blockquote') {
      const callout = toCallout(child);
      if (callout) parent.children[i] = callout;
    }
  }
}

function toCallout(quote: Blockquote): Callout | undefined {
  const first = quote.children[0];
  if (first?.type !== 'paragraph') return undefined;
  const head = first.children[0];
  if (head?.type !== 'text') return undefined;
  const m = CALLOUT_MARKER.exec(head.value);
  if (!m) return undefined;
  const markerLength = m[0].length;

  // Split the paragraph at its first line break: title before, body after.
  const title: PhrasingContent[] = [];
  const rest: PhrasingContent[] = [];
  let inTitle = true;
  first.children.forEach((node, index) => {
    if (!inTitle) {
      rest.push(node);
      return;
    }
    let value = node.type === 'text' ? node.value : undefined;
    if (index === 0 && value !== undefined)
      value = value.slice(markerLength).replace(/^[ \t]+/, '');
    if (value !== undefined) {
      const nl = value.indexOf('\n');
      if (nl >= 0) {
        inTitle = false;
        if (nl > 0) title.push({ type: 'text', value: value.slice(0, nl) });
        if (nl + 1 < value.length) rest.push({ type: 'text', value: value.slice(nl + 1) });
        return;
      }
      if (value) title.push({ ...node, value } as PhrasingContent);
      return;
    }
    if (node.type === 'break') {
      inTitle = false;
      return;
    }
    title.push(node);
  });

  const body = quote.children.slice(1);
  if (rest.length) body.unshift({ type: 'paragraph', children: rest } satisfies Paragraph);
  const callout: Callout = {
    type: 'callout',
    calloutType: m[1]!.toLowerCase(),
    title,
    children: body,
  };
  if (m[2]) callout.fold = m[2] as '+' | '-';
  if (quote.position) callout.position = quote.position;
  return callout;
}
