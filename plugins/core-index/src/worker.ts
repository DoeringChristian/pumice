import { extractMetadata } from '@pumice/markdown';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; text: string }>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (e) => {
  const { id, text } = e.data;
  try {
    scope.postMessage({ id, meta: extractMetadata(text) });
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
