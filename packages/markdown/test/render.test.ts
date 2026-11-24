import { describe, expect, it, test } from 'vitest';
import { parseMarkdown, renderHtml } from '../src';

const render = (md: string) =>
  renderHtml(parseMarkdown(md), { isResolved: (t) => t !== 'Missing' });

test('dialect elements', () => {
  const html = render(
    '# Head #t\n\n[[k7f3qm2xa1|Name]] [[Missing]] ==hi== %%gone%% $x$ ^b1\n\n![[pic.png|300]]\n\n> [!tip]- Title\n> body\n',
  );
  expect(html).toContain(
    '<h1 data-heading="Head #t">Head <a class="tag" href="#" data-tag="t">#t</a></h1>',
  );
  expect(html).toContain('<a class="internal-link" href="#" data-target="k7f3qm2xa1">Name</a>');
  expect(html).toContain('class="internal-link is-unresolved"');
  expect(html).toContain('<mark>hi</mark>');
  expect(html).not.toContain('gone');
  expect(html).toContain('data-tex="x"');
  expect(html).toContain('data-alias="300"');
  expect(html).toContain('class="callout is-collapsed" data-callout="tip" data-callout-fold="-"');
});

test('html is sanitized', () => {
  const html = render(
    '<b onclick="x()">bold</b><script>alert(1)</script><img src="javascript:x">\n\n[a](javascript:alert(1))',
  );
  expect(html).toContain('<b>bold</b>');
  expect(html).not.toMatch(/onclick|<script|javascript:/);
});

test('markdown links to notes are internal', () => {
  expect(render('[x](Some%20note.md#Part)')).toContain(
    'data-target="Some note.md" data-subpath="Part"',
  );
});

describe('references', () => {
  it('reads @fig-loss as a link to that label, and leaves mail addresses alone', () => {
    const out = renderHtml(parseMarkdown('See @fig-loss and (@eq2), not a@fig-x or @figure.'), {
      isResolved: () => true,
      linkText: (l) => `<${l.subpath}>`,
    });
    expect(out).toContain('data-subpath="^fig-loss"');
    expect(out).toContain('&#x3C;^fig-loss>');
    expect(out).toContain('data-subpath="^eq2"');
    // (`@figure` may be a key of a bibliography: it is marked, and reads as it is written.)
    expect(out).toContain('a@fig-x or <span class="pm-cite" data-key="figure">@figure</span>.');
  });
  it('keeps a link inside the caption of an embed', () => {
    const out = renderHtml(parseMarkdown('![[a.png|As in [[#^fig-b|that]] one|300]] after'), {
      isResolved: () => true,
    });
    expect(out).toContain('data-alias="As in [[#^fig-b|that]] one|300"');
    expect(out).toContain(' after');
  });
});

describe('citations', () => {
  it('marks what may be a citation, and gives the sentence its punctuation back', () => {
    const out = renderHtml(
      parseMarkdown('As @doe:2020 says. See [@a_b, p. 3; @c-d]. Like @fig-x. Mail a@b.org.'),
      { isResolved: () => true, linkText: () => 'Figure 1' },
    );
    expect(out).toContain('<span class="pm-cite" data-key="doe:2020">@doe:2020</span> says.');
    expect(out).toContain('[<span class="pm-cite" data-key="a_b">@a_b</span>, p. 3; ');
    expect(out).toContain('<span class="pm-cite" data-key="c-d">@c-d</span>].');
    expect(out).toContain('data-subpath="^fig-x"');
    expect(out).toContain('>Figure 1</a>. Mail');
    expect(out).not.toContain('data-key="b.org"');
  });
});
