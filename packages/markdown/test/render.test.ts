import { expect, test } from 'vitest';
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
