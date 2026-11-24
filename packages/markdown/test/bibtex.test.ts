import { describe, expect, it } from 'vitest';
import {
  citationText,
  citedKeys,
  parseBibtex,
  referenceLine,
  referenceList,
  shortAuthors,
} from '../src/bibtex';

const BIB = String.raw`
% a comment
@string{nips = "Advances in Neural Information Processing Systems"}
@comment{ignored @article{no, title = {x}}}

@article{veach1997,
  author = {Veach, Eric and Guibas, Leonidas J.},
  title = {{Metropolis} Light Transport},
  journal = "Proc. " # {SIGGRAPH},
  volume = 31, pages = {65--76},
  year = 1997,
  doi = {10.1145/258734.258775}
}

@inproceedings{muller:2019,
  author    = {Thomas M{\"u}ller and Brian McWilliams and Fabrice Rousselle and Markus Gross and Jan Nov\'ak},
  title     = {Neural Importance Sampling},
  booktitle = nips,
  year      = {2019},
  url = {https://example.org/a_b}
}

@book{knuth, author = {Donald E. Knuth}, title = {The {\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}
@misc{group, author = {{The Pumice Authors} and Ludwig van Beethoven}, title = {Notes}}
`;

describe('BibTeX', () => {
  const entries = parseBibtex(BIB);
  const by = new Map(entries.map((e) => [e.key, e]));

  it('reads entries, abbreviations, joined values and accents', () => {
    expect(entries.map((e) => e.key)).toEqual(['veach1997', 'muller:2019', 'knuth', 'group']);
    const veach = by.get('veach1997')!;
    expect(veach.authors).toEqual([
      { family: 'Veach', given: 'Eric' },
      { family: 'Guibas', given: 'Leonidas J.' },
    ]);
    expect(veach.title).toBe('Metropolis Light Transport');
    expect(veach.fields.journal).toBe('Proc. SIGGRAPH');
    expect(veach.fields.pages).toBe('65–76');
    expect(veach.url).toBe('https://doi.org/10.1145/258734.258775');
    const muller = by.get('muller:2019')!;
    expect(muller.authors[0]).toEqual({ family: 'Müller', given: 'Thomas' });
    expect(muller.authors[4]!.family).toBe('Novák');
    expect(muller.fields.booktitle).toBe('Advances in Neural Information Processing Systems');
    expect(muller.url).toBe('https://example.org/a_b');
    expect(by.get('group')!.authors).toEqual([
      { family: 'The Pumice Authors' },
      { family: 'van Beethoven', given: 'Ludwig' },
    ]);
  });

  it('says how a citation and a reference read', () => {
    const veach = by.get('veach1997')!;
    const muller = by.get('muller:2019')!;
    expect(shortAuthors(veach)).toBe('Veach and Guibas');
    expect(shortAuthors(muller)).toBe('Müller et al.');
    expect(citationText(veach, { style: 'numeric', number: 2, bracketed: false })).toBe('[2]');
    expect(citationText(veach, { style: 'numeric', number: 2, bracketed: true })).toBe('2');
    expect(citationText(muller, { style: 'author-year', number: 1, bracketed: false })).toBe(
      'Müller et al. (2019)',
    );
    expect(
      citationText(by.get('group')!, { style: 'author-year', number: 1, bracketed: true }),
    ).toBe('The Pumice Authors and van Beethoven n.d.');
    expect(referenceLine(veach)).toBe(
      'E. Veach and L. J. Guibas. Metropolis Light Transport. Proc. SIGGRAPH 31:65–76. 1997.',
    );
    expect(referenceLine(by.get('knuth')!)).toBe('D. E. Knuth. The book. Addison-Wesley, 1984.');
  });

  it('finds what a text cites, in order', () => {
    const text =
      'As @muller:2019 and [@veach1997, p. 3; @muller:2019]. See @fig-a, @fig2, a@b.c, @knuth.';
    expect(citedKeys(text)).toEqual(['muller:2019', 'veach1997', 'knuth']);
    expect(
      citedKeys('---\nauthor: @knuth\n---\nA `@veach1997` b\n```py\n@property\n```\n@muller:2019'),
    ).toEqual(['muller:2019']);
    expect(referenceList(citedKeys(text), by, 'numeric').map((e) => e.key)).toEqual([
      'muller:2019',
      'veach1997',
      'knuth',
    ]);
    expect(referenceList(citedKeys(text), by, 'author-year').map((e) => e.key)).toEqual([
      'knuth',
      'muller:2019',
      'veach1997',
    ]);
  });
});
