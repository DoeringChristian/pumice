const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Moment-style date formatting for the common tokens (YYYY MM DD HH mm ss, names, week). */
export function formatDate(date: Date, format: string): string {
  const tokens: Record<string, () => string> = {
    YYYY: () => String(date.getFullYear()),
    YY: () => String(date.getFullYear()).slice(-2),
    MMMM: () => MONTHS[date.getMonth()]!,
    MMM: () => MONTHS[date.getMonth()]!.slice(0, 3),
    MM: () => pad(date.getMonth() + 1),
    M: () => String(date.getMonth() + 1),
    DD: () => pad(date.getDate()),
    D: () => String(date.getDate()),
    dddd: () => DAYS[date.getDay()]!,
    ddd: () => DAYS[date.getDay()]!.slice(0, 3),
    HH: () => pad(date.getHours()),
    H: () => String(date.getHours()),
    mm: () => pad(date.getMinutes()),
    ss: () => pad(date.getSeconds()),
    ww: () => pad(isoWeek(date)),
    w: () => String(isoWeek(date)),
  };
  // Text in [brackets] is literal, as in moment.js.
  return format.replace(
    /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss|ww|w/g,
    (m, literal: string | undefined) => (literal !== undefined ? literal : tokens[m]!()),
  );
}

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
