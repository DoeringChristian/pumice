/**
 * The parser-independent "semantic" view of a document: the nodes the app relies on (links,
 * embeds, tags, headings, block IDs, callouts, frontmatter, comments, math, highlights) with
 * their source ranges. Both parsers are reduced to this form so they can be compared.
 */
import { parser as baseParser } from '@lezer/markdown';
import type { Tree } from '@lezer/common';
import type { Nodes, Root } from 'mdast';
import { CALLOUT_MARKER, parseWikiLinkContent } from './links';
import { dialectExtensions, FrontmatterSyntax } from './lezer';

export type SemanticNode =
  | {
      kind: 'link' | 'embed';
      from: number;
      to: number;
      target: string;
      subpath?: string;
      alias?: string;
    }
  | { kind: 'tag'; from: number; to: number; value: string }
  | { kind: 'heading'; from: number; to: number; level: number }
  | { kind: 'blockId'; from: number; to: number; value: string }
  | { kind: 'callout'; from: number; to: number; type: string }
  | { kind: 'frontmatter' | 'comment' | 'math' | 'highlight'; from: number; to: number };

const byPosition = (a: SemanticNode, b: SemanticNode) =>
  a.from - b.from || b.to - a.to || a.kind.localeCompare(b.kind);

export function semanticFromMdast(tree: Root): SemanticNode[] {
  const out: SemanticNode[] = [];
  const walk = (node: Nodes) => {
    const from = node.position?.start.offset ?? 0;
    const to = node.position?.end.offset ?? 0;
    switch (node.type) {
      case 'wikiLink': {
        const n: SemanticNode = {
          kind: node.embed ? 'embed' : 'link',
          from,
          to,
          target: node.target,
        };
        if (node.subpath) n.subpath = node.subpath;
        if (node.alias !== undefined) n.alias = node.alias;
        out.push(n);
        break;
      }
      case 'tag':
        out.push({ kind: 'tag', from, to, value: node.value });
        break;
      case 'heading':
        out.push({ kind: 'heading', from, to, level: node.depth });
        break;
      case 'blockId':
        out.push({ kind: 'blockId', from, to, value: node.value });
        break;
      case 'callout':
        out.push({ kind: 'callout', from, to, type: node.calloutType });
        for (const child of node.title) walk(child);
        break;
      case 'yaml':
        out.push({ kind: 'frontmatter', from, to });
        break;
      case 'comment':
        out.push({ kind: 'comment', from, to });
        break;
      case 'math':
      case 'inlineMath':
        out.push({ kind: 'math', from, to });
        break;
      case 'highlight':
        out.push({ kind: 'highlight', from, to });
        break;
    }
    if ('children' in node) for (const child of node.children) walk(child as Nodes);
  };
  walk(tree);
  return out.sort(byPosition);
}

let lezerParser: typeof baseParser | undefined;

/** The Lezer parser configured with the full dialect, including frontmatter. */
export function dialectLezerParser(): typeof baseParser {
  return (lezerParser ??= baseParser.configure([FrontmatterSyntax, ...dialectExtensions]));
}

export function semanticFromLezer(tree: Tree, text: string): SemanticNode[] {
  const out: SemanticNode[] = [];
  tree.iterate({
    enter(ref) {
      const { from, to, name } = ref;
      if (name === 'WikiLink' || name === 'Embed') {
        const embed = name === 'Embed';
        const content = text.slice(from + (embed ? 3 : 2), to - 2);
        out.push({ kind: embed ? 'embed' : 'link', from, to, ...parseWikiLinkContent(content) });
        return false;
      }
      const heading = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(name);
      if (heading) out.push({ kind: 'heading', from, to, level: Number(heading[1]) });
      else if (name === 'Tag') out.push({ kind: 'tag', from, to, value: text.slice(from + 1, to) });
      else if (name === 'BlockId')
        out.push({ kind: 'blockId', from, to, value: text.slice(from + 1, to) });
      else if (name === 'Frontmatter') out.push({ kind: 'frontmatter', from, to });
      else if (name === 'Comment' || name === 'CommentBlock')
        out.push({ kind: 'comment', from, to });
      else if (name === 'InlineMath' || name === 'InlineMathDisplay' || name === 'MathBlock')
        out.push({ kind: 'math', from, to });
      else if (name === 'Highlight') out.push({ kind: 'highlight', from, to });
      else if (name === 'Blockquote') {
        const type = calloutTypeAt(text, from);
        if (type) out.push({ kind: 'callout', from, to, type });
      }
      return undefined;
    },
  });
  return out.sort(byPosition);
}

/** The callout type if the blockquote starting at `from` is a callout. */
export function calloutTypeAt(text: string, from: number): string | undefined {
  const lineEnd = text.indexOf('\n', from);
  const line = text.slice(from, lineEnd < 0 ? text.length : lineEnd);
  const m = /^>[ \t]?/.exec(line);
  if (!m) return undefined;
  return CALLOUT_MARKER.exec(line.slice(m[0].length))?.[1]?.toLowerCase();
}
