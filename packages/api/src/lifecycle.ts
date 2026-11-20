export interface Disposable {
  dispose(): void;
}

export type DisposableLike = Disposable | (() => void);

export function toDisposable(d: DisposableLike): Disposable {
  return typeof d === 'function' ? { dispose: d } : d;
}

/** Collects disposables and disposes them in reverse order of registration. */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  add<T extends DisposableLike>(d: T): T {
    if (this.disposed) {
      toDisposable(d).dispose();
    } else {
      this.items.push(toDisposable(d));
    }
    return d;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const item of this.items.reverse()) {
      try {
        item.dispose();
      } catch (e) {
        errors.push(e);
      }
    }
    this.items = [];
    if (errors.length) throw new AggregateError(errors, 'Errors while disposing');
  }
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(e);
      } catch (err) {
        console.error('[pumice] event listener failed', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
