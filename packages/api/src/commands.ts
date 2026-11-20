import type { Disposable, Event } from './lifecycle';

export interface CommandRegistration {
  id: string;
  title: string;
  category?: string;
  /** Hotkeys like `Mod+P`, `Mod+Shift+O` (Mod = Cmd on macOS, Ctrl elsewhere). */
  hotkeys?: string[];
  /** When it returns false the command is hidden from the palette and hotkeys don't fire. */
  when?: () => boolean;
  run: (...args: unknown[]) => unknown;
}

export interface CommandInfo {
  id: string;
  title: string;
  category?: string;
  hotkeys: string[];
  /** Declared in a manifest but its plugin is not active yet. */
  lazy: boolean;
}

export interface CommandsApi {
  register(command: CommandRegistration): Disposable;
  execute(id: string, ...args: unknown[]): Promise<unknown>;
  /** Commands available right now (respects `when`). */
  list(): CommandInfo[];
  /** Runs the command bound to this key event, if any. Returns true when handled. */
  handleKeyEvent(event: KeyboardEvent): boolean;
  readonly onDidChange: Event<void>;
}
