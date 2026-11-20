import {
  Emitter,
  type CommandContribution,
  type CommandInfo,
  type CommandRegistration,
  type CommandsApi,
  type Disposable,
  matchesHotkey,
  parseHotkey,
  type ParsedHotkey,
} from '@pumice/api';

interface Registered {
  command: CommandRegistration;
  hotkeys: ParsedHotkey[];
}

interface LazyCommand {
  contribution: CommandContribution;
  pluginId: string;
}

export class CommandRegistry {
  private commands = new Map<string, Registered>();
  private lazy = new Map<string, LazyCommand>();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly isMac: boolean,
    /** Activates the plugin that contributes a lazy command. */
    private readonly activatePlugin: (pluginId: string) => Promise<void>,
  ) {}

  addContribution(pluginId: string, contribution: CommandContribution): void {
    this.lazy.set(contribution.id, { contribution, pluginId });
    this.changed.fire();
  }

  register(command: CommandRegistration): Disposable {
    if (this.commands.has(command.id))
      throw new Error(`Command '${command.id}' already registered`);
    const entry = { command, hotkeys: (command.hotkeys ?? []).map(parseHotkey) };
    this.commands.set(command.id, entry);
    this.changed.fire();
    return {
      dispose: () => {
        if (this.commands.get(command.id) === entry) {
          this.commands.delete(command.id);
          this.changed.fire();
        }
      },
    };
  }

  async execute(id: string, ...args: unknown[]): Promise<unknown> {
    let entry = this.commands.get(id);
    if (!entry) {
      const lazy = this.lazy.get(id);
      if (!lazy) throw new Error(`Unknown command '${id}'`);
      await this.activatePlugin(lazy.pluginId);
      entry = this.commands.get(id);
      if (!entry) throw new Error(`Plugin '${lazy.pluginId}' did not register command '${id}'`);
    }
    return entry.command.run(...args);
  }

  list(): CommandInfo[] {
    const result: CommandInfo[] = [];
    for (const { command } of this.commands.values()) {
      if (command.when && !command.when()) continue;
      result.push({
        id: command.id,
        title: command.title,
        category: command.category,
        hotkeys: command.hotkeys ?? [],
        lazy: false,
      });
    }
    for (const [id, { contribution }] of this.lazy) {
      if (this.commands.has(id)) continue;
      result.push({ ...contribution, hotkeys: [], lazy: true });
    }
    return result.sort((a, b) => label(a).localeCompare(label(b)));
  }

  handleKeyEvent(event: KeyboardEvent): boolean {
    for (const { command, hotkeys } of this.commands.values()) {
      if (!hotkeys.some((h) => matchesHotkey(h, event, this.isMac))) continue;
      if (command.when && !command.when()) continue;
      event.preventDefault();
      void Promise.resolve()
        .then(() => command.run())
        .catch((e) => console.error(`[pumice] command '${command.id}' failed`, e));
      return true;
    }
    return false;
  }

  /** The API object handed to plugins; registrations are tracked by the caller. */
  api(track: (d: Disposable) => void): CommandsApi {
    return {
      register: (c) => {
        const d = this.register(c);
        track(d);
        return d;
      },
      execute: (id, ...args) => this.execute(id, ...args),
      list: () => this.list(),
      handleKeyEvent: (e) => this.handleKeyEvent(e),
      onDidChange: this.onDidChange,
    };
  }
}

function label(c: CommandInfo): string {
  return c.category ? `${c.category}: ${c.title}` : c.title;
}
