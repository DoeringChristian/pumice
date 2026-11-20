import { formatDate, frontmatterBounds } from '@pumice/api';

export { formatDate };

export function renderTemplate(text: string, vars: { title?: string; date?: Date }): string {
  const date = vars.date ?? new Date();
  let out = text.replace(
    /\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/g,
    (_m, name: string, format: string | undefined) => {
      if (name === 'title') return vars.title ?? '';
      if (name === 'date') return formatDate(date, format?.trim() || 'YYYY-MM-DD');
      return formatDate(date, format?.trim() || 'HH:mm');
    },
  );
  // Templates must not hand their ID to every note made from them.
  const fm = frontmatterBounds(out);
  if (fm) {
    const yaml = out.slice(fm.contentFrom, fm.contentTo);
    const kept = yaml.split(/\r?\n/).filter((line) => !/^id\s*:/.test(line));
    out = kept.some((l) => l.trim())
      ? out.slice(0, fm.contentFrom) + kept.join('\n') + out.slice(fm.contentTo)
      : out.slice(fm.to);
  }
  return out;
}
