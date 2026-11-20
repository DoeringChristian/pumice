import type { FileMetadata } from '@pumice/api';

/** Where markdown gets parsed: inline (tests, custom syntax) or in a worker. */
export interface ParserHost {
  parse(text: string): Promise<FileMetadata>;
  dispose(): void;
}

export function inlineParser(extract: (text: string) => FileMetadata): ParserHost {
  return {
    async parse(text) {
      return extract(text);
    },
    dispose() {},
  };
}

interface Pending {
  resolve(meta: FileMetadata): void;
  reject(error: Error): void;
}

/**
 * Parses in a dedicated worker so indexing a large vault doesn't block the UI. Falls back to
 * `fallback` if workers are unavailable or the worker fails.
 */
export function workerParser(fallback: ParserHost): ParserHost {
  if (typeof Worker === 'undefined') return fallback;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'pumice-index',
    });
  } catch {
    return fallback;
  }
  let broken = false;
  let next = 0;
  const pending = new Map<number, Pending>();
  worker.onmessage = (e: MessageEvent<{ id: number; meta?: FileMetadata; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.meta) p.resolve(e.data.meta);
    else p.reject(new Error(e.data.error ?? 'parse failed'));
  };
  worker.onerror = (e) => {
    console.warn('[core.index] parser worker failed, parsing on the main thread', e.message);
    broken = true;
    for (const p of pending.values()) p.reject(new Error('worker failed'));
    pending.clear();
    worker.terminate();
  };
  return {
    parse(text) {
      if (broken) return fallback.parse(text);
      const id = next++;
      return new Promise<FileMetadata>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, text });
      }).catch(() => fallback.parse(text));
    },
    dispose() {
      worker.terminate();
      pending.clear();
    },
  };
}
