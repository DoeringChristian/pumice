import type { Nodes, Parent, Root } from 'mdast';
import { parse as parseYaml } from 'yaml';
import { citedKeys } from './bibtex';
import { numberItems, type NumberedItem } from './figures';
import { parseMarkdown, type ParseOptions } from './mdast';

export interface LinkRef {
  /** `link`/`embed`: wikilink syntax; `mdlink`/`mdembed`: `[text](url)` / `![alt](url)`. */
  kind: 'link' | 'embed' | 'mdlink' | 'mdembed';
  /** Target before `#` (an ID, a name or a path; URL-decoded for markdown links). */
  target: string;
  subpath?: string;
  /** Text after `|` for wikilinks, link text for markdown links. */
  alias?: string;
  from: number;
  to: number;
}

export interface HeadingRef {
  level: number;
  text: string;
  from: number;
  to: number;
}

export interface BlockRef {
  id: string;
  /** Range of the block the ID labels. */
  from: number;
  to: number;
}

export interface TagRef {
  /** Without `#`, as written. */
  tag: string;
  /** -1 for tags from the `tags` property. */
  from: number;
}

export interface TaskRef {
  text: string;
  done: boolean;
  from: number;
}

export interface FileMetadata {
  frontmatter?: Record<string, unknown>;
  /** Source range of the frontmatter block including fences. */
  frontmatterRange?: { from: number; to: number };
  frontmatterError?: string;
  id?: string;
  title?: string;
  aliases: string[];
  tags: TagRef[];
  links: LinkRef[];
  headings: HeadingRef[];
  blocks: BlockRef[];
  tasks: TaskRef[];
  /** Numbered figures, tables and equations, in order (see `figures.ts`). */
  figures: FigureRef[];
  /** What is written `@key` in the note, each once, in order: its citations, if the keys exist. */
  citations: string[];
}

/** A numbered figure, table or equation of a note. */
export type FigureRef = Pick<NumberedItem, 'kind' | 'number' | 'id' | 'caption'>;

const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i;

/** Values of a list-ish property: YAML list, comma-separated string or single value. */
export function listProperty(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(listProperty);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  return [String(value)];
}

function textOf(node: Nodes): string {
  if (node.type === 'tag') return `#${node.value}`;
  if (node.type === 'blockId') return '';
  if (node.type === 'citation') return `@${node.value}`;
  if ('value' in node && typeof node.value === 'string' && node.type !== 'comment') {
    return node.type === 'yaml' ? '' : node.value;
  }
  if (node.type === 'wikiLink') return node.alias || node.subpath || node.target;
  if ('children' in node) return (node.children as Nodes[]).map(textOf).join('');
  return '';
}

export interface ExtractOptions extends ParseOptions {
  /** Frontmatter key holding the note ID (default `id`). */
  idKey?: string;
}

export function extractMetadata(text: string, opts: ExtractOptions = {}): FileMetadata {
  return metadataFromTree(parseMarkdown(text, opts), opts, text);
}

export function metadataFromTree(
  tree: Root,
  opts: ExtractOptions = {},
  /** The note's text, for what is read from it directly (figure numbering). */
  text?: string,
): FileMetadata {
  const meta: FileMetadata = {
    aliases: [],
    tags: [],
    links: [],
    headings: [],
    blocks: [],
    tasks: [],
    citations: text === undefined ? [] : citedKeys(text),
    figures:
      text === undefined
        ? []
        : numberItems(text).map(({ kind, number, id, caption }) => ({
            kind,
            number,
            ...(id ? { id } : {}),
            ...(caption ? { caption } : {}),
          })),
  };
  const idKey = opts.idKey ?? 'id';
  const start = (n: Nodes) => n.position?.start.offset ?? 0;
  const end = (n: Nodes) => n.position?.end.offset ?? 0;

  const visit = (node: Nodes, parents: Parent[]) => {
    switch (node.type) {
      case 'yaml': {
        meta.frontmatterRange = { from: start(node), to: end(node) };
        try {
          const data = parseYaml(node.value) as unknown;
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const fm = data as Record<string, unknown>;
            meta.frontmatter = fm;
            if (typeof fm.title === 'string' && fm.title.trim()) meta.title = fm.title.trim();
            meta.aliases = listProperty(fm.aliases ?? fm.alias);
            for (const tag of listProperty(fm.tags ?? fm.tag)) {
              meta.tags.push({ tag: tag.replace(/^#/, ''), from: -1 });
            }
          }
        } catch (e) {
          meta.frontmatterError = e instanceof Error ? e.message : String(e);
        }
        return;
      }
      case 'heading':
        meta.headings.push({
          level: node.depth,
          text: textOf(node).trim(),
          from: start(node),
          to: end(node),
        });
        break;
      case 'tag':
        meta.tags.push({ tag: node.value, from: start(node) });
        return;
      case 'wikiLink': {
        const link: LinkRef = {
          kind: node.embed ? 'embed' : 'link',
          target: node.target,
          from: start(node),
          to: end(node),
        };
        if (node.subpath) link.subpath = node.subpath;
        if (node.alias !== undefined) link.alias = node.alias;
        meta.links.push(link);
        return;
      }
      case 'link':
      case 'image': {
        if (!EXTERNAL_URL.test(node.url) && !node.url.startsWith('#') && node.url) {
          const hash = node.url.indexOf('#');
          const rawTarget = hash >= 0 ? node.url.slice(0, hash) : node.url;
          let target = rawTarget;
          try {
            target = decodeURIComponent(rawTarget);
          } catch {
            // keep raw
          }
          const link: LinkRef = {
            kind: node.type === 'image' ? 'mdembed' : 'mdlink',
            target,
            from: start(node),
            to: end(node),
          };
          if (hash >= 0) link.subpath = decodeURIComponent(node.url.slice(hash + 1));
          const alias = node.type === 'image' ? (node.alt ?? '') : textOf(node);
          if (alias) link.alias = alias;
          meta.links.push(link);
        }
        break;
      }
      case 'blockId': {
        meta.blocks.push({ id: node.value, ...blockRange(node, parents) });
        return;
      }
      case 'listItem':
        if (typeof node.checked === 'boolean') {
          const first = node.children[0];
          meta.tasks.push({
            text: first ? textOf(first).trim() : '',
            done: node.checked,
            from: start(node),
          });
        }
        break;
      case 'code':
      case 'inlineCode':
      case 'math':
      case 'inlineMath':
      case 'comment':
      case 'html':
        return;
    }
    if ('children' in node) {
      const nextParents = [...parents, node as Parent];
      for (const child of node.children as Nodes[]) visit(child, nextParents);
    }
    if (node.type === 'callout') {
      for (const child of node.title) visit(child, [...parents, node]);
    }
  };

  /**
   * The block an ID labels: the enclosing list item or paragraph, or — for an ID alone in its
   * own paragraph (after a table, list or quote) — the previous sibling block.
   */
  function blockRange(node: Nodes, parents: Parent[]): { from: number; to: number } {
    const paragraph = parents[parents.length - 1];
    const container = parents[parents.length - 2];
    if (paragraph?.type === 'paragraph' && paragraph.children.length === 1 && container) {
      const index = container.children.indexOf(paragraph as never);
      const previous = container.children[index - 1] as Nodes | undefined;
      if (previous) return { from: start(previous), to: end(previous) };
    }
    for (let i = parents.length - 1; i >= 0; i--) {
      const p = parents[i] as Nodes;
      if (p.type === 'listItem') return { from: start(p), to: end(p) };
    }
    const target = (paragraph as Nodes | undefined) ?? node;
    return { from: start(target), to: end(target) };
  }

  visit(tree, []);
  return meta;
}
