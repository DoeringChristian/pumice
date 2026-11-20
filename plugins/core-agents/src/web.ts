/**
 * Web access for the built-in assistant: a search and a page reader. Both go through the
 * platform's fetch (the app's own page cannot reach the network), and both return plain text.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1]!.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const stripTags = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

export const searchUrl = (query: string) =>
  `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

/** The results on DuckDuckGo's plain HTML results page. */
export function parseSearchResults(html: string, limit = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
      block,
    );
    if (!link) continue;
    let url = decodeEntities(link[1]!);
    // Results are wrapped in a redirect that carries the real address.
    const wrapped = /[?&]uddg=([^&]+)/.exec(url);
    if (wrapped) url = decodeURIComponent(wrapped[1]!);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(
      block,
    );
    results.push({
      title: stripTags(link[2]!),
      url,
      snippet: snippet ? stripTags(snippet[1]!) : '',
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** A page's title and readable text (links kept as "text (address)"). */
export function htmlToText(html: string, base?: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  // The article itself, when the page marks it.
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(body);
  if (main && main[2]!.length > 500) body = main[2]!;
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(script|style|noscript|svg|template|iframe|nav|footer|form|head)\b[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(
      /<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, '').trim();
        if (!text) return ' ';
        let url = decodeEntities(href);
        try {
          if (base) url = new URL(url, base).href;
        } catch {
          // Keep it as written.
        }
        return /^https?:/i.test(url) && text !== url ? `${text} (${url})` : text;
      },
    )
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|h[1-6]|ul|ol|table|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(body)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/** The address as the user sees it in an approval, and the site it belongs to. */
export function parseWebUrl(value: unknown): { url: string; host: string } {
  let url: URL;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Give a full address, like https://example.com/page.');
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new Error('Only https addresses can be opened.');
  if (url.username || url.password)
    throw new Error('Addresses with a login in them are not opened.');
  const host = url.hostname.toLowerCase();
  // Nothing on this computer or the local network.
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.includes(':') ||
    !host.includes('.')
  )
    throw new Error('Only public web addresses can be opened.');
  return { url: url.href, host };
}
