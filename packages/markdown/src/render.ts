/**
 * mdast → sanitized HTML for the reading view and embeds. Dialect nodes become plain elements
 * with `data-*` attributes; embeds, math and diagram blocks become placeholders that the reader
 * hydrates (lazily, with its contribution-point renderers).
 */
import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { raw } from 'hast-util-raw';
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';
import type { Nodes, Parents, Root } from 'mdast';
import { defaultHandlers, toHast, type Handler, type State } from 'mdast-util-to-hast';
import type { Callout, Comment, Highlight, Tag, WikiLink, BlockId } from './mdast';
import { embedSizeCss, parseEmbedSize, parseImageAttributes, withAliasSize } from './links';

const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i;

export interface RenderOptions {
  /**
   * Display text for an internal link without alias (e.g. the target note's title for ID links).
   * Defaults to the target/subpath as written.
   */
  linkText?(link: { target: string; subpath?: string }): string;
  /** Whether a link target resolves (unresolved links get the `is-unresolved` class). */
  isResolved?(target: string): boolean;
}

function el(
  tagName: string,
  properties: Element['properties'],
  children: ElementContent[] = [],
): Element {
  return { type: 'element', tagName, properties, children };
}

function defaultLinkText(link: { target: string; subpath?: string }): string {
  if (!link.target && link.subpath) return link.subpath.replace(/^\^/, '').replace(/#/g, ' > ');
  const name = link.target.split('/').pop()!.replace(/\.md$/i, '');
  return link.subpath ? `${name} > ${link.subpath.replace(/#/g, ' > ')}` : name;
}

export function toHastTree(tree: Root, opts: RenderOptions = {}): HastRoot {
  const linkText = opts.linkText ?? defaultLinkText;

  const internalLink = (
    target: string,
    subpath: string | undefined,
    children: ElementContent[],
  ): Element => {
    const resolved = !target || (opts.isResolved?.(target) ?? true);
    return el(
      'a',
      {
        className: ['internal-link', ...(resolved ? [] : ['is-unresolved'])],
        href: '#',
        dataTarget: target,
        ...(subpath ? { dataSubpath: subpath } : {}),
      },
      children,
    );
  };

  const embed = (
    target: string,
    subpath: string | undefined,
    alias: string | undefined,
    markdown: boolean,
  ): Element =>
    el('span', {
      className: ['pm-embed'],
      dataTarget: target,
      ...(subpath ? { dataSubpath: subpath } : {}),
      ...(alias !== undefined ? { dataAlias: alias } : {}),
      ...(markdown ? { dataMarkdown: 'true' } : {}),
    });

  /**
   * The alias of an image with the size of the attributes that follow it, as pandoc writes
   * them (`![[plot.png]]{width=50%}`, `![](plot.png){ width=300 height=200 }`). The
   * attributes are taken out of the text behind the image: they are not shown.
   */
  const withAttributes = (
    node: Nodes,
    parent: Parents | undefined,
    alias: string | undefined,
  ): string | undefined => {
    const next = parent?.children[parent.children.indexOf(node as never) + 1];
    if (next?.type !== 'text') return alias;
    const found = parseImageAttributes(next.value);
    if (!found) return alias;
    next.value = next.value.slice(found.length);
    return found.size ? withAliasSize(alias, found.size) : alias;
  };

  const handlers: Record<string, Handler> = {
    wikiLink(_state: State, node: WikiLink, parent: Parents | undefined) {
      if (node.embed)
        return embed(node.target, node.subpath, withAttributes(node, parent, node.alias), false);
      const text =
        node.alias ||
        linkText({ target: node.target, ...(node.subpath ? { subpath: node.subpath } : {}) });
      return internalLink(node.target, node.subpath, [{ type: 'text', value: text }]);
    },
    highlight(state: State, node: Highlight) {
      return el('mark', {}, state.all(node) as ElementContent[]);
    },
    tag(_state: State, node: Tag) {
      return el('a', { className: ['tag'], href: '#', dataTag: node.value }, [
        { type: 'text', value: `#${node.value}` },
      ]);
    },
    blockId(_state: State, node: BlockId) {
      return el('span', { className: ['pm-block-id'], dataBlockId: node.value });
    },
    comment(_state: State, _node: Comment) {
      return undefined;
    },
    callout(state: State, node: Callout) {
      const title = node.title.length
        ? (state.all({ type: 'paragraph', children: node.title }) as ElementContent[])
        : [
            {
              type: 'text' as const,
              value: node.calloutType.charAt(0).toUpperCase() + node.calloutType.slice(1),
            },
          ];
      const titleEl = el('div', { className: ['callout-title'] }, [
        el('span', { className: ['callout-icon'] }),
        el('span', { className: ['callout-title-inner'] }, title),
        ...(node.fold ? [el('span', { className: ['callout-fold'] })] : []),
      ]);
      const content = el(
        'div',
        { className: ['callout-content'] },
        state.wrap(state.all(node), true) as ElementContent[],
      );
      return el(
        'div',
        {
          className: ['callout', ...(node.fold === '-' ? ['is-collapsed'] : [])],
          dataCallout: node.calloutType,
          ...(node.fold ? { dataCalloutFold: node.fold } : {}),
        },
        [titleEl, content],
      );
    },
    inlineMath(_state: State, node: { value: string; data?: { display?: boolean } }) {
      return el('span', {
        className: ['pm-math', node.data?.display ? 'is-display' : 'is-inline'],
        dataTex: node.value,
      });
    },
    math(_state: State, node: { value: string }) {
      return el('div', { className: ['pm-math', 'is-display'], dataTex: node.value });
    },
    link(state: State, node: Extract<Nodes, { type: 'link' }>) {
      const children = state.all(node) as ElementContent[];
      if (EXTERNAL_URL.test(node.url) || node.url.startsWith('#')) {
        return el(
          'a',
          {
            className: ['external-link'],
            href: node.url,
            ...(node.title ? { title: node.title } : {}),
          },
          children,
        );
      }
      const [target, subpath] = splitUrl(node.url);
      return internalLink(target, subpath, children);
    },
    image(_state: State, node: Extract<Nodes, { type: 'image' }>, parent: Parents | undefined) {
      const alias = withAttributes(node, parent, node.alt ?? undefined);
      if (EXTERNAL_URL.test(node.url)) {
        // A picture from the web is shown as it is; its size is its own.
        const css = embedSizeCss(parseEmbedSize(alias));
        const style = [
          css.width ? `width:${css.width};max-width:100%` : '',
          css.aspectRatio ? `aspect-ratio:${css.aspectRatio};height:auto` : '',
          css.height ? `height:${css.height}` : '',
        ]
          .filter(Boolean)
          .join(';');
        return el('img', {
          src: node.url,
          alt: node.alt ?? '',
          ...(node.title ? { title: node.title } : {}),
          ...(style ? { style } : {}),
        });
      }
      const [target, subpath] = splitUrl(node.url);
      return embed(target, subpath, alias, true);
    },
    heading(state: State, node: Extract<Nodes, { type: 'heading' }>) {
      return el(
        `h${node.depth}`,
        { dataHeading: plainText(node) },
        state.all(node) as ElementContent[],
      );
    },
    code(_state: State, node: Extract<Nodes, { type: 'code' }>) {
      const lang = node.lang?.toLowerCase();
      if (lang && lang !== 'plain' && lang !== 'text') {
        // Code-block renderers (mermaid, query blocks, …) can claim the block when hydrating.
        return el('pre', { className: ['pm-code-block'], dataLang: lang }, [
          el('code', { className: [`language-${lang}`] }, [{ type: 'text', value: node.value }]),
        ]);
      }
      return el('pre', {}, [el('code', {}, [{ type: 'text', value: node.value }])]);
    },
    yaml() {
      return undefined;
    },
    listItem(state: State, node: Extract<Nodes, { type: 'listItem' }>, parent) {
      const li = defaultHandlers.listItem(state, node, parent);
      // Source offset of task items, so the reading view can toggle the checkbox in the file.
      if (typeof node.checked === 'boolean' && node.position?.start.offset !== undefined) {
        li.properties.dataTaskOffset = node.position.start.offset;
      }
      return li;
    },
  };

  const hast = toHast(tree, { handlers, allowDangerousHtml: true }) as HastRoot;
  return sanitize(raw(hast), schema) as HastRoot;
}

function splitUrl(url: string): [string, string | undefined] {
  const hash = url.indexOf('#');
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return hash >= 0
    ? [decode(url.slice(0, hash)), decode(url.slice(hash + 1))]
    : [decode(url), undefined];
}

function plainText(node: Nodes): string {
  if (node.type === 'tag') return `#${node.value}`;
  if ('value' in node && typeof node.value === 'string') return node.value;
  if (node.type === 'wikiLink') return node.alias || node.target;
  if ('children' in node) return (node.children as Nodes[]).map(plainText).join('');
  return '';
}

/** Default GitHub-style schema plus classes, data attributes and the dialect's elements. */
const schema: Schema = {
  ...defaultSchema,
  clobberPrefix: '',
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'mark',
    'details',
    'summary',
    'figure',
    'figcaption',
    'u',
    'small',
    'abbr',
    'kbd',
  ],
  attributes: {
    // Element-specific className restrictions would override the global `className` below.
    ...Object.fromEntries(
      Object.entries(defaultSchema.attributes ?? {}).map(([tag, attrs]) => [
        tag,
        attrs.filter((a) => !(Array.isArray(a) && a[0] === 'className')),
      ]),
    ),
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'data*', 'style'],
    input: [['disabled', true], ['type', 'checkbox'], 'checked'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto', 'tel', 'obsidian', 'pumice'],
  },
};

export function renderHtml(tree: Root, opts: RenderOptions = {}): string {
  return toHtml(toHastTree(tree, opts));
}
