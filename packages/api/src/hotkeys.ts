export interface ParsedHotkey {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Ctrl on macOS when `Mod` means Cmd; ignored elsewhere. */
  ctrl: boolean;
}

/** Parses `Mod+Shift+P`. Keys are compared case-insensitively. */
export function parseHotkey(spec: string): ParsedHotkey {
  const parts = spec.split('+').map((p) => p.trim());
  const key = parts.pop();
  if (!key) throw new Error(`Invalid hotkey '${spec}'`);
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    key: key.toLowerCase(),
    mod: mods.has('mod') || mods.has('cmd') || mods.has('meta'),
    shift: mods.has('shift'),
    alt: mods.has('alt') || mods.has('option'),
    ctrl: mods.has('ctrl'),
  };
}

export function matchesHotkey(hotkey: ParsedHotkey, event: KeyboardEvent, isMac: boolean): boolean {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const ctrl = isMac ? event.ctrlKey : false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  // With Shift held, event.key is the shifted character; fall back to the physical key code.
  const codeKey = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : undefined;
  return (
    (key === hotkey.key || codeKey === hotkey.key) &&
    mod === hotkey.mod &&
    event.shiftKey === hotkey.shift &&
    event.altKey === hotkey.alt &&
    ctrl === hotkey.ctrl
  );
}

export function formatHotkey(spec: string, isMac: boolean): string {
  const h = parseHotkey(spec);
  const parts: string[] = [];
  if (isMac) {
    if (h.ctrl) parts.push('⌃');
    if (h.alt) parts.push('⌥');
    if (h.shift) parts.push('⇧');
    if (h.mod) parts.push('⌘');
    return parts.join('') + h.key.toUpperCase();
  }
  if (h.mod) parts.push('Ctrl');
  if (h.alt) parts.push('Alt');
  if (h.shift) parts.push('Shift');
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return parts.join('+');
}
