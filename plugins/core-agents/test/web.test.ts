import { describe, expect, it } from 'vitest';
import { htmlToText, parseSearchResults, parseWebUrl } from '../src/web';

describe('parseSearchResults', () => {
  it('reads titles, real addresses and snippets', () => {
    const html = `
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcodemirror.net%2Fexamples%2Fdecoration%2F&amp;rut=abc">CodeMirror <b>Decoration</b> Example</a></h2>
        <a class="result__snippet" href="x">Marks, widgets &amp; <b>block</b> decorations.</a>
      </div>
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result web-result"><a class="result__a" href="https://example.org/a">Plain</a></div>`;
    expect(parseSearchResults(html)).toEqual([
      {
        title: 'CodeMirror Decoration Example',
        url: 'https://codemirror.net/examples/decoration/',
        snippet: 'Marks, widgets & block decorations.',
      },
      { title: 'Plain', url: 'https://example.org/a', snippet: '' },
    ]);
  });
});

describe('htmlToText', () => {
  it('keeps the text and structure, drops code and chrome', () => {
    const { title, text } = htmlToText(
      `<html><head><title>A &amp; B</title><style>p{}</style></head><body>
        <nav><a href="/">Home</a></nav>
        <h1>Heading</h1><p>First <b>para</b> with a <a href="/doc">link</a>.</p>
        <script>alert(1)</script><ul><li>one</li><li>two</li></ul>
      </body></html>`,
      'https://example.org/x/',
    );
    expect(title).toBe('A & B');
    expect(text).toBe(
      '# Heading\n\nFirst para with a link (https://example.org/doc).\n\n- one\n- two',
    );
  });
});

describe('parseWebUrl', () => {
  it('accepts public https addresses', () => {
    expect(parseWebUrl('http://Example.org/a?b=1')).toEqual({
      url: 'https://example.org/a?b=1',
      host: 'example.org',
    });
  });
  it('refuses local and odd addresses', () => {
    for (const bad of [
      'file:///etc/passwd',
      'https://localhost/x',
      'https://192.168.1.4/',
      'https://10.0.0.1/',
      'https://printer.local/',
      'https://user:pw@example.org/',
      'https://intranet/',
      'not a url',
    ])
      expect(() => parseWebUrl(bad), bad).toThrow();
  });
});
