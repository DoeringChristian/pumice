import { PlatformService, SettingsUi, definePlugin, type PluginModule } from '@pumice/api';
import { button, h, select, settingItem, textInput, toggle } from '@pumice/ui';
import manifestJson from '../manifest.json';

export const manifest = manifestJson;

type Mode = 'system' | 'light' | 'dark';
const SNIPPETS = '.pumice/snippets';
const THEMES = '.pumice/themes';

export const plugin = definePlugin({
  async activate(ctx) {
    const platform = ctx.use(PlatformService);
    const settingsUi = ctx.use(SettingsUi);
    const root = document.documentElement;
    const styleEls = new Map<string, HTMLStyleElement>();

    const applyMode = () => {
      const mode = ctx.settings.get<Mode>('mode', 'system');
      if (mode === 'system') delete root.dataset.theme;
      else root.dataset.theme = mode;
    };
    const applyVars = () => {
      const accent = ctx.settings.get('accent', '');
      if (accent) {
        root.style.setProperty('--accent', accent);
        root.style.setProperty('--link', accent);
        root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 15%, transparent)`);
        root.style.setProperty('--selection', `color-mix(in srgb, ${accent} 22%, transparent)`);
      } else {
        for (const v of ['--accent', '--link', '--accent-soft', '--selection'])
          root.style.removeProperty(v);
      }
      const size = ctx.settings.get('textSize', 16);
      root.style.setProperty('--font-size-text', `${size}px`);
      const font = ctx.settings.get('textFont', '');
      if (font) root.style.setProperty('--font-text', font);
      else root.style.removeProperty('--font-text');
    };

    const listCss = async (dir: string) =>
      (await platform.fs.list())
        .filter(
          (e) =>
            e.kind === 'file' &&
            e.path.startsWith(`${dir}/`) &&
            e.path.endsWith('.css') &&
            !e.path.slice(dir.length + 1).includes('/'),
        )
        .map((e) => e.path.slice(dir.length + 1, -4))
        .sort();

    const setStyle = (key: string, css: string | undefined) => {
      let el = styleEls.get(key);
      if (css === undefined) {
        el?.remove();
        styleEls.delete(key);
        return;
      }
      if (!el) {
        el = document.createElement('style');
        el.dataset.pumice = key;
        styleEls.set(key, el);
      }
      el.textContent = css;
      // Snippets after the theme, both after built-in styles.
      document.head.append(el);
    };

    const applyCss = async () => {
      const theme = ctx.settings.get('theme', '');
      setStyle(
        'theme',
        theme
          ? await platform.fs.readText(`${THEMES}/${theme}.css`).catch(() => undefined)
          : undefined,
      );
      const enabled = ctx.settings.get<string[]>('snippets', []);
      const available = await listCss(SNIPPETS);
      for (const key of [...styleEls.keys()]) {
        if (key.startsWith('snippet:') && !enabled.includes(key.slice(8))) setStyle(key, undefined);
      }
      for (const name of enabled.filter((n) => available.includes(n))) {
        setStyle(
          `snippet:${name}`,
          await platform.fs.readText(`${SNIPPETS}/${name}.css`).catch(() => undefined),
        );
      }
    };

    applyMode();
    applyVars();
    await applyCss();
    ctx.register(() => {
      for (const el of styleEls.values()) el.remove();
      delete root.dataset.theme;
    });
    // Edited snippets apply immediately (desktop).
    if (platform.watcher) {
      ctx.register(
        platform.watcher.watch((events) => {
          if (
            events.some((e) => e.path.startsWith(`${SNIPPETS}/`) || e.path.startsWith(`${THEMES}/`))
          )
            void applyCss();
        }),
      );
    }

    ctx.register(
      settingsUi.registerTab({
        id: 'appearance',
        title: 'Appearance',
        order: 0,
        render(container) {
          const render = async () => {
            const snippets = await listCss(SNIPPETS);
            const themes = await listCss(THEMES);
            const enabled = new Set(ctx.settings.get<string[]>('snippets', []));
            container.replaceChildren(
              h('h2', {}, 'Appearance'),
              settingItem(
                'Base color scheme',
                'Follow the system, or always use light or dark.',
                select<Mode>(
                  ctx.settings.get<Mode>('mode', 'system'),
                  [
                    ['system', 'System'],
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                  ],
                  (mode) => {
                    void ctx.settings.set('mode', mode).then(applyMode);
                  },
                  'Color scheme',
                ),
              ),
              settingItem(
                'Accent color',
                'Links, selection and highlights.',
                h(
                  'div',
                  { class: 'pm-row-actions' },
                  (() => {
                    const input = h('input', {
                      type: 'color',
                      value: ctx.settings.get('accent', '') || '#c8582e',
                      'aria-label': 'Accent color',
                    });
                    input.addEventListener(
                      'input',
                      () => void ctx.settings.set('accent', input.value).then(applyVars),
                    );
                    return input;
                  })(),
                  button(
                    'Reset',
                    () => void ctx.settings.set('accent', '').then(() => (applyVars(), render())),
                    { kind: 'plain' },
                  ),
                ),
              ),
              settingItem(
                'Text size',
                'Font size of notes in pixels.',
                (() => {
                  const input = h('input', {
                    type: 'range',
                    min: 12,
                    max: 24,
                    step: 1,
                    value: String(ctx.settings.get('textSize', 16)),
                    'aria-label': 'Text size',
                  });
                  input.addEventListener(
                    'input',
                    () => void ctx.settings.set('textSize', Number(input.value)).then(applyVars),
                  );
                  return input;
                })(),
              ),
              settingItem(
                'Text font',
                'A CSS font-family for notes; empty uses the interface font.',
                textInput(
                  ctx.settings.get('textFont', ''),
                  (v) => void ctx.settings.set('textFont', v.trim()).then(applyVars),
                  { placeholder: 'e.g. Georgia, serif' },
                ),
              ),
              h('h3', {}, 'Themes'),
              settingItem(
                'Theme',
                `CSS files in ${THEMES}/ restyle the whole app through its CSS variables.`,
                select(
                  ctx.settings.get('theme', ''),
                  [['', 'Default'], ...themes.map((t): [string, string] => [t, t])],
                  (t) => {
                    void ctx.settings.set('theme', t).then(applyCss);
                  },
                  'Theme',
                ),
              ),
              h('h3', {}, 'CSS snippets'),
              h(
                'p',
                { class: 'pm-setting-desc' },
                `Small CSS files in ${SNIPPETS}/, applied after the theme.`,
              ),
              ...(snippets.length
                ? snippets.map((name) =>
                    settingItem(
                      name,
                      `${SNIPPETS}/${name}.css`,
                      toggle(
                        enabled.has(name),
                        (on) => {
                          const next = new Set(ctx.settings.get<string[]>('snippets', []));
                          if (on) next.add(name);
                          else next.delete(name);
                          void ctx.settings.set('snippets', [...next]).then(applyCss);
                        },
                        { label: `Snippet ${name}` },
                      ),
                    ),
                  )
                : [h('p', { class: 'pm-setting-desc' }, 'No snippets yet.')]),
              h(
                'div',
                { class: 'pm-row-actions' },
                button('New snippet', async () => {
                  await platform.fs.mkdir(SNIPPETS);
                  let name = 'snippet';
                  for (let i = 1; snippets.includes(name); i++) name = `snippet ${i}`;
                  await platform.fs.write(
                    `${SNIPPETS}/${name}.css`,
                    '/* Pumice CSS snippet. Example: */\n/* .pm-markdown-page { max-width: 900px; } */\n',
                  );
                  void render();
                }),
                button('Reload snippets', () => void applyCss().then(render), { kind: 'plain' }),
              ),
            );
          };
          void render();
        },
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
