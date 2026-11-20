/** Callout type → icon and color family, with Obsidian's aliases. */
const CALLOUTS: Record<string, [icon: string, color: string]> = {
  note: ['pencil', 'blue'],
  abstract: ['clipboard-list', 'cyan'],
  summary: ['clipboard-list', 'cyan'],
  tldr: ['clipboard-list', 'cyan'],
  info: ['info', 'blue'],
  todo: ['check-circle', 'blue'],
  tip: ['flame', 'cyan'],
  hint: ['flame', 'cyan'],
  important: ['flame', 'cyan'],
  success: ['check-circle', 'green'],
  check: ['check-circle', 'green'],
  done: ['check-circle', 'green'],
  question: ['help-circle', 'orange'],
  help: ['help-circle', 'orange'],
  faq: ['help-circle', 'orange'],
  warning: ['alert-triangle', 'orange'],
  caution: ['alert-triangle', 'orange'],
  attention: ['alert-triangle', 'orange'],
  failure: ['x-circle', 'red'],
  fail: ['x-circle', 'red'],
  missing: ['x-circle', 'red'],
  danger: ['zap', 'red'],
  error: ['zap', 'red'],
  bug: ['bug', 'red'],
  example: ['list', 'purple'],
  quote: ['quote', 'gray'],
  cite: ['quote', 'gray'],
};

export function calloutStyle(type: string): { icon: string; color: string } {
  const [icon, color] = CALLOUTS[type.toLowerCase()] ?? CALLOUTS.note!;
  return { icon, color };
}
