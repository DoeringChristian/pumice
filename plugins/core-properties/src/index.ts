import {
  Documents,
  MetadataIndex,
  Workspace,
  definePlugin,
  deleteProperty,
  markdownText,
  setProperty,
  type DocumentsApi,
  type PluginModule,
  type TextChange,
  type VaultPath,
} from '@pumice/api';
import { createIcon, debounce, h } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';
import './properties.css';

export const manifest = manifestJson;

/** Keys with a fixed meaning (docs/plan/03). */
const RESERVED: Record<string, string> = {
  id: 'Note ID (Note IDs plugin): [[id|Name]] links point here; change it with “Change note ID”',
  aliases: 'Other names for this note (used by links and search)',
  tags: 'Tags',
  cssclasses: 'CSS classes for this note',
  title: 'Display title (default: the file name)',
};

async function edit(
  documents: DocumentsApi,
  path: VaultPath,
  change: (text: string) => TextChange | null,
): Promise<boolean> {
  const handle = await documents.open(path);
  try {
    const ytext = markdownText(handle.doc);
    const c = change(ytext.toString());
    if (!c) return false;
    handle.doc.transact(() => {
      if (c.to > c.from) ytext.delete(c.from, c.to - c.from);
      if (c.insert) ytext.insert(c.from, c.insert);
    });
    return true;
  } finally {
    handle.dispose();
  }
}

/** Parses what the user typed into a property value, keeping the value's previous type. */
export function parseValue(input: string, previous: unknown): unknown {
  const text = input.trim();
  if (Array.isArray(previous) || (/,/.test(text) && previous === undefined)) {
    return text
      ? text
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
  }
  if (typeof previous === 'number' && text !== '' && !Number.isNaN(Number(text)))
    return Number(text);
  if (typeof previous === 'boolean') return /^(true|yes|1)$/i.test(text);
  return text;
}

const display = (value: unknown) =>
  Array.isArray(value)
    ? value.map(String).join(', ')
    : value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const index = ctx.use(MetadataIndex);
    const documents = ctx.use(Documents);

    ctx.register(
      workspace.registerView({
        type: 'properties',
        title: 'Properties',
        icon: 'clipboard-list',
        create(view) {
          const body = h('div', { class: 'pm-panel-scroll pm-properties' });
          view.container.append(h('div', { class: 'pm-panel' }, body));

          const render = () => {
            // Don't re-render under the user's cursor.
            if (body.contains(document.activeElement)) return;
            body.replaceChildren();
            const path = workspace.activeFile;
            const file = path ? index.getFile(path) : undefined;
            if (!path || !file || !path.toLowerCase().endsWith('.md')) {
              body.append(h('div', { class: 'pm-panel-empty' }, 'No note open.'));
              return;
            }
            const meta = file.meta;
            if (meta?.frontmatterError) {
              body.append(
                h(
                  'div',
                  { class: 'pm-panel-empty pm-properties-error' },
                  `The frontmatter is not valid YAML: ${meta.frontmatterError.split('\n')[0]}`,
                ),
              );
              return;
            }
            const fm = meta?.frontmatter ?? {};
            for (const [key, value] of Object.entries(fm)) {
              const input = h('input', {
                class: 'pm-panel-input',
                value: display(value),
                readOnly: key === 'id',
                'aria-label': key,
                placeholder: Array.isArray(value) ? 'Comma-separated values' : 'Empty',
              });
              const commit = () => {
                const next = parseValue(input.value, value);
                if (display(next) === display(value)) return;
                void edit(documents, path, (text) => setProperty(text, key, next));
              };
              input.addEventListener('change', commit);
              input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') input.blur();
                if (e.key === 'Escape') {
                  input.value = display(value);
                  input.blur();
                }
              });
              input.addEventListener('blur', () => setTimeout(render, 0));
              const remove = h(
                'button',
                {
                  class: 'pm-property-remove',
                  title: `Remove “${key}”`,
                  'aria-label': `Remove ${key}`,
                  onclick: () => void edit(documents, path, (text) => deleteProperty(text, key)),
                },
                createIcon('x', 13),
              );
              body.append(
                h(
                  'div',
                  { class: 'pm-property-row' },
                  h('span', { class: 'pm-property-key', title: RESERVED[key] ?? key }, key),
                  input,
                  key === 'id' ? null : remove,
                ),
              );
            }
            if (!Object.keys(fm).length)
              body.append(h('div', { class: 'pm-panel-empty' }, 'No properties.'));
            const add = h(
              'button',
              {
                class: 'pm-panel-button pm-properties-add',
                onclick: async () => {
                  const key = await workspace.showPrompt({
                    title: 'Property name',
                    placeholder: 'e.g. status',
                  });
                  const name = key?.trim();
                  if (!name) return;
                  if (name in fm) {
                    workspace.notify(`“${name}” already exists.`, { kind: 'warning' });
                    return;
                  }
                  await edit(documents, path, (text) =>
                    setProperty(text, name, name === 'tags' || name === 'aliases' ? [] : ''),
                  );
                },
              },
              createIcon('plus', 13),
              ' Add property',
            );
            body.append(add);
          };
          const later = debounce(render, 200);
          const subs = [workspace.onDidChangeActiveFile(render), index.onDidChange(later)];
          render();
          return { dispose: () => (later.cancel(), subs.forEach((s) => s.dispose())) };
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'properties',
        side: 'right',
        viewType: 'properties',
        title: 'Properties',
        icon: 'clipboard-list',
        order: 15,
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
