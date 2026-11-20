import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { VaultPath } from '@pumice/api';
import { RESERVED, linkTarget } from './spec';
import { opens, type FrameViewer } from './viewers';

/** Where the cursor is in a frame block, as far as suggestions go. */
export type FramePlace =
  | { kind: 'file'; from: number }
  | { kind: 'key'; from: number }
  | { kind: 'value'; key: string; from: number; bracketed: boolean };

export interface FrameBlockInfo {
  /** Index of the opening fence in `lines`. */
  start: number;
  /** Top-level keys the block has. */
  keys: string[];
  /** What `file:` says (a link target or a path), if anything. */
  file?: string;
  place?: FramePlace;
}

const OPEN = /^\s*(`{3,}|~{3,})\s*frame\s*$/;
const ANY_FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * The frame block around line `index`, and what could be suggested at `column` of that line.
 * Undefined outside frame blocks.
 */
export function frameBlockAt(
  lines: string[],
  index: number,
  column: number,
): FrameBlockInfo | undefined {
  let start = -1;
  for (let i = index - 1; i >= 0 && i >= index - 400; i--) {
    if (!ANY_FENCE.test(lines[i]!)) continue;
    // The nearest fence above: the block is a frame block if that opens one.
    if (OPEN.test(lines[i]!)) start = i;
    break;
  }
  if (start < 0 || ANY_FENCE.test(lines[index] ?? '')) return undefined;
  const keys: string[] = [];
  let file: string | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_FENCE.test(lines[i]!)) break;
    const key = /^([\w-]+)\s*:(.*)$/.exec(lines[i]!);
    if (!key) continue;
    keys.push(key[1]!);
    if (key[1] === 'file' && i !== index) file = linkTarget(key[2]!) ?? key[2]!.trim();
  }
  const before = (lines[index] ?? '').slice(0, column);
  let place: FramePlace | undefined;
  const fileValue = /^file\s*:\s*/.exec(before);
  const keyValue = /^([\w-]+)\s*:\s*(\[\[)?([^[\]]*)$/.exec(before);
  const item = /^\s+-\s*(\[\[)?([^[\]]*)$/.exec(before);
  if (fileValue) place = { kind: 'file', from: fileValue[0].length };
  // Also after the indentation a list above leaves behind: a setting starts a line.
  else if (/^\s*[\w-]*$/.test(before))
    place = { kind: 'key', from: /^\s*/.exec(before)![0].length };
  else if (keyValue)
    place = {
      kind: 'value',
      key: keyValue[1]!,
      from: before.length - keyValue[3]!.length,
      bracketed: !!keyValue[2],
    };
  else if (item) {
    // A list item belongs to the nearest key above it.
    for (let i = index - 1; i > start; i--) {
      const key = /^([\w-]+)\s*:/.exec(lines[i]!);
      if (key) {
        place = {
          kind: 'value',
          key: key[1]!,
          from: before.length - item[2]!.length,
          bracketed: !!item[1],
        };
        break;
      }
    }
  }
  return { start, keys, ...(file ? { file } : {}), ...(place ? { place } : {}) };
}

export interface FrameCompletionDeps {
  /** Every frame in the frames folder: its HTML file, and its manifest if it has one. */
  frames(): Array<{ entry: VaultPath; name: string; viewer?: FrameViewer }>;
  /** The HTML file a block's `file:` value means. */
  entryOf(file: string, sourcePath: VaultPath): VaultPath | undefined;
  files(): VaultPath[];
  sourcePath(): VaultPath | undefined;
}

const KEY_HELP: Record<string, string> = {
  file: 'the frame to show',
  caption: 'text under the frame',
  width: 'pixels',
  height: 'pixels',
};

/** Suggestions inside a frame block: the frame, its settings, the files it takes. */
export function frameCompletionSource(deps: FrameCompletionDeps) {
  return (context: CompletionContext): CompletionResult | null => {
    const sourcePath = deps.sourcePath();
    if (sourcePath === undefined) return null;
    const { state, pos } = context;
    const line = state.doc.lineAt(pos);
    const first = Math.max(1, line.number - 400);
    const last = Math.min(state.doc.lines, line.number + 400);
    const lines: string[] = [];
    for (let n = first; n <= last; n++) lines.push(state.doc.line(n).text);
    const info = frameBlockAt(lines, line.number - first, pos - line.from);
    if (!info?.place) return null;
    const place = info.place;
    const entry = info.file ? deps.entryOf(info.file, sourcePath) : undefined;
    const viewer = entry ? deps.frames().find((f) => f.entry === entry)?.viewer : undefined;
    const from = line.from + place.from;
    // Replaces what is typed up to the end of the line, brackets closed automatically included.
    const replaceLine =
      (text: string, then?: (view: EditorView, end: number) => void, wholeLine = false) =>
      (view: EditorView, _c: Completion, at: number) => {
        const l = view.state.doc.lineAt(at);
        const start = wholeLine ? l.from : at;
        view.dispatch({
          changes: { from: start, to: l.to, insert: text },
          selection: { anchor: start + text.length },
          userEvent: 'input.complete',
        });
        then?.(view, start + text.length);
      };

    if (place.kind === 'file') {
      const options = deps.frames().map((f) => ({
        label: f.name,
        detail: f.viewer ? `shows ${f.viewer.extensions.map((e) => `.${e}`).join(', ')}` : f.entry,
        apply: replaceLine(`[[${f.entry}]]`, (view, end) => {
          // Go on with what the frame shows.
          const v = f.viewer;
          if (!v || info.keys.includes(v.setting)) return;
          const next = v.multiple ? `\n${v.setting}:\n  - ` : `\n${v.setting}: `;
          view.dispatch({
            changes: { from: end, insert: next },
            selection: { anchor: end + next.length },
            userEvent: 'input.complete',
          });
          startCompletion(view);
        }),
      }));
      return { from, options, filter: true };
    }

    if (place.kind === 'key') {
      const wanted = [
        ...(viewer ? [viewer.setting] : []),
        ...Object.keys(viewer?.settings ?? {}),
        ...RESERVED,
      ].filter((k, i, all) => all.indexOf(k) === i && !info.keys.includes(k));
      const options = wanted.map((key, i) => {
        const doc = viewer?.settings[key];
        const main = viewer?.setting === key;
        return {
          label: key,
          detail:
            doc?.description ??
            (main ? `the file${viewer!.multiple ? 's' : ''} to show` : (KEY_HELP[key] ?? '')),
          boost: -i,
          apply: replaceLine(
            main && viewer!.multiple ? `${key}:\n  - ` : `${key}: `,
            (view) => {
              if (main || doc?.values || doc?.type === 'file' || key === 'file')
                startCompletion(view);
            },
            // A setting starts its line, whatever indentation was left there.
            true,
          ),
        };
      });
      return { from, options, validFor: /^[\w-]*$/ };
    }

    const doc = viewer?.settings[place.key];
    const start = from - (place.bracketed ? 2 : 0);
    if (viewer?.setting === place.key || doc?.type === 'file') {
      const takes = (p: VaultPath) => (viewer?.setting === place.key ? opens(viewer, p) : true);
      const options = deps
        .files()
        .filter(takes)
        .sort()
        .slice(0, 300)
        .map((path) => ({
          label: path,
          apply: (view: EditorView) => {
            const l = view.state.doc.lineAt(start);
            const text = `[[${path}]]`;
            view.dispatch({
              changes: { from: start, to: l.to, insert: text },
              selection: { anchor: start + text.length },
              userEvent: 'input.complete',
            });
          },
        }));
      return { from, options, filter: true };
    }
    if (doc?.values?.length && !place.bracketed) {
      return {
        from,
        options: doc.values.map((value) => ({
          label: value,
          ...(value === doc.default ? { detail: 'default' } : {}),
          apply: replaceLine(value),
        })),
        filter: true,
      };
    }
    return null;
  };
}
