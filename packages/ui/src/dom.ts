type Child = Node | string | null | undefined | false;

/** Tiny element builder for plain-DOM views: `h('div', { class: 'x', onclick }, child…)`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key in el && typeof value !== 'string') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/** Calls `fn` at most once per `ms`, trailing. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Renders `text` with `[from, to)` ranges wrapped in <mark>. */
export function highlighted(text: string, ranges: Array<[number, number]>): DocumentFragment {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from < pos) continue;
    frag.append(text.slice(pos, from), h('mark', {}, text.slice(from, to)));
    pos = to;
  }
  frag.append(text.slice(pos));
  return frag;
}

/** A settings row: name and description on the left, a control on the right. */
export function settingItem(
  name: string,
  description: string | Node | null,
  control: Node | null,
): HTMLElement {
  return h(
    'div',
    { class: 'pm-setting' },
    h(
      'div',
      { class: 'pm-setting-info' },
      h('div', { class: 'pm-setting-name' }, name),
      description ? h('div', { class: 'pm-setting-desc' }, description) : null,
    ),
    control ? h('div', { class: 'pm-setting-control' }, control) : null,
  );
}

export function toggle(
  checked: boolean,
  onChange: (checked: boolean) => void,
  opts: { disabled?: boolean; label?: string } = {},
): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    class: 'pm-toggle',
    checked,
    disabled: !!opts.disabled,
    'aria-label': opts.label ?? 'Toggle',
  });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

export function textInput(
  value: string,
  onChange: (value: string) => void,
  opts: { placeholder?: string; label?: string } = {},
): HTMLInputElement {
  const input = h('input', {
    class: 'pm-text-input',
    type: 'text',
    value,
    placeholder: opts.placeholder ?? '',
    'aria-label': opts.label ?? opts.placeholder ?? '',
  });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

export function select<T extends string>(
  value: T,
  options: Array<[T, string]>,
  onChange: (value: T) => void,
  label = '',
): HTMLSelectElement {
  const el = h('select', { class: 'pm-select', 'aria-label': label });
  for (const [v, text] of options)
    el.append(h('option', { value: v, selected: v === value }, text));
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

export function button(
  text: string,
  onClick: () => void,
  opts: { kind?: 'primary' | 'danger' | 'plain' } = {},
): HTMLButtonElement {
  return h(
    'button',
    { class: `pm-button${opts.kind ? ` is-${opts.kind}` : ''}`, onclick: onClick },
    text,
  );
}
