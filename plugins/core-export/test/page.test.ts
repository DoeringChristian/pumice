import { describe, expect, it } from 'vitest';
import { extensionFor, fileName, pageHtml, rewriteCssUrls } from '../src/page';

describe('export page', () => {
  it('makes a file name of a title', () => {
    expect(fileName('Plan: Q3 / "draft"')).toBe('Plan Q3 draft');
    expect(fileName('  ??  ')).toBe('Note');
  });
  it('names files by their media type', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('video/webm; codecs=vp9')).toBe('webm');
    expect(extensionFor('application/x-unknown', 'dat')).toBe('dat');
  });
  it('writes the addresses in CSS anew, leaving data and fragments', async () => {
    const css =
      '@font-face{src:url(fonts/a.woff2) format("woff2"),url("b.woff")}i{mask:url(#m);background:url(data:x)}';
    const seen: string[] = [];
    const out = await rewriteCssUrls(css, async (url) => {
      seen.push(url);
      return url.endsWith('woff2') ? 'assets/font-1.woff2' : undefined;
    });
    expect(seen).toEqual(['fonts/a.woff2', 'b.woff']);
    expect(out).toBe(
      '@font-face{src:url("assets/font-1.woff2") format("woff2"),url("b.woff")}i{mask:url(#m);background:url(data:x)}',
    );
  });
  it('puts a note into a page of its own', () => {
    const html = pageHtml({
      title: 'A <b> & c',
      body: '<p>text</p>',
      css: 'p{color:red}</style><script>x</script>',
      rootAttributes: { 'data-theme': 'dark' },
    });
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('<title>A &lt;b&gt; &amp; c</title>');
    expect(html).toContain('<p>text</p>');
    expect(html).not.toContain('</style><script>x');
  });
});
