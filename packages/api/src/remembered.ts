/**
 * Values remembered on this device under a key (how large a file is, how high something was
 * drawn): written a moment after they are learned, the oldest making room for new ones.
 */
export class Remembered<V> {
  private values = new Map<string, V>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private save: ((text: string) => void) | undefined;

  constructor(
    private readonly same: (a: V, b: V) => boolean,
    private readonly most = 5000,
  ) {}

  /** Reads what was kept, and keeps what is learned from here on. */
  keep(text: string | undefined, save: (text: string) => void): void {
    this.save = save;
    try {
      for (const [key, value] of JSON.parse(text ?? '[]') as Array<[string, V]>)
        // (What was learned since counts.)
        if (value && !this.values.has(key)) this.values.set(key, value);
    } catch {
      // Learned again.
    }
  }

  get(key: string): V | undefined {
    return this.values.get(key);
  }

  learn(key: string, value: V): void {
    const old = this.values.get(key);
    if (old !== undefined && this.same(old, value)) return;
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.most) this.values.delete(this.values.keys().next().value!);
    this.later();
  }

  /** What it was learned from changed: it may not hold. */
  forget(key: string): void {
    if (this.values.delete(key)) this.later();
  }

  private later(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1500);
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save?.(JSON.stringify([...this.values]));
  }

  dispose(): void {
    if (this.timer) this.flush();
    this.save = undefined;
  }
}
