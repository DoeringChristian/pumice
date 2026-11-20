import {
  basename,
  formatWikiLink,
  normalizePath,
  type DocumentsApi,
  type MetadataIndexApi,
  type VaultChange,
  type VaultPath,
} from '@pumice/api';
import { editNote } from './links';

const stripMd = (p: string) => p.replace(/\.md$/i, '');

/** Whether link text `target` (as written in `source`) meant `oldPath` before it moved. */
export function pointedAt(target: string, oldPath: VaultPath, source: VaultPath): boolean {
  const t = stripMd(normalizePath(target)).toLowerCase();
  const old = stripMd(oldPath).toLowerCase();
  if (!t) return false;
  if (t === old || old.endsWith(`/${t}`)) return true;
  const sourceDir = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
  return sourceDir !== '' && stripMd(normalizePath(`${sourceDir}/${target}`)).toLowerCase() === old;
}

/**
 * After a note moved inside Pumice, rewrites plain `[[Name]]`, `[[path/Name]]` and markdown
 * links that pointed at it. ID links need nothing. Returns the number of links changed.
 */
export async function rewriteLinksAfterRename(
  renames: Array<{ oldPath: VaultPath; newPath: VaultPath }>,
  index: MetadataIndexApi,
  documents: DocumentsApi,
): Promise<number> {
  let count = 0;
  const bySource = new Map<
    VaultPath,
    Array<{ from: number; to: number; insert: string; raw?: string }>
  >();
  for (const file of index.files()) {
    for (const r of index.outgoing(file.path)) {
      const link = r.link;
      if (r.via === 'plugin' || r.via === 'self') continue;
      const rename = renames.find(
        (x) =>
          // Still resolves to the moved file through a name it kept: nothing to do.
          !(r.target === x.newPath && (r.via === 'name' || r.via === 'alias')) &&
          pointedAt(link.target, x.oldPath, file.path),
      );
      if (!rename) continue;
      const newName = basename(rename.newPath);
      const unique = !index
        .files()
        .some(
          (f) =>
            f.path !== rename.newPath && basename(f.path).toLowerCase() === newName.toLowerCase(),
        );
      const wroteFullPath = link.target.includes('/');
      const keepExt = /\.md$/i.test(link.target);
      let target = wroteFullPath || !unique ? rename.newPath : newName;
      if (!keepExt) target = stripMd(target);
      let insert: string;
      if (link.kind === 'link' || link.kind === 'embed') {
        insert = formatWikiLink(
          {
            target,
            ...(link.subpath ? { subpath: link.subpath } : {}),
            ...(link.alias !== undefined ? { alias: link.alias } : {}),
          },
          { embed: link.kind === 'embed' },
        );
      } else {
        const url =
          encodeURI(wroteFullPath || !unique ? rename.newPath : newName) +
          (link.subpath ? `#${encodeURIComponent(link.subpath)}` : '');
        const text = link.alias ?? '';
        insert = `${link.kind === 'mdembed' ? '!' : ''}[${text}](${url.includes(' ') ? `<${url}>` : url})`;
      }
      const list = bySource.get(file.path) ?? [];
      list.push({ from: link.from, to: link.to, insert });
      bySource.set(file.path, list);
    }
  }
  for (const [source, changes] of bySource) {
    const meta = index.getFile(source)?.meta;
    const ok = await editNote(documents, source, (text) => {
      // Only apply if the text at each range still is a link (the index may lag behind edits).
      const valid = changes.filter((c) => {
        const raw = text.slice(c.from, c.to);
        return raw !== c.insert && /^!?\[/.test(raw) && /[\])]$/.test(raw);
      });
      return valid.length ? valid : null;
    });
    if (ok && meta) count += changes.length;
  }
  return count;
}

/** Pairs of in-app renames of markdown files in a vault change batch. */
export function markdownRenames(
  changes: VaultChange[],
): Array<{ oldPath: VaultPath; newPath: VaultPath }> {
  const out: Array<{ oldPath: VaultPath; newPath: VaultPath }> = [];
  for (const c of changes) {
    if (c.type === 'rename' && !c.external && c.entry.kind === 'file')
      out.push({ oldPath: c.oldPath, newPath: c.entry.path });
  }
  return out;
}
