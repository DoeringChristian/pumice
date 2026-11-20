# Markdown conformance corpus

Each case is `corpus/<name>.md` plus `corpus/<name>.json`, the expected _semantic_ nodes:
links, embeds, tags, headings, block IDs, callouts, frontmatter, comments, math and highlights,
each given by its kind and exact source text (plus target/alias/value where relevant).

The runner (`test/conformance.test.ts`) parses every case with both parsers — micromark → mdast
(reading view, index) and Lezer (editor) — and fails if either differs from the expectation.

Expectations describe how Obsidian renders the file. They were written by hand from Obsidian's
documented behaviour; when a case is checked against a real Obsidian install, note it in the
case's `"verified"` field.
