import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a build script, without types
import { runtimeSource } from '../scripts/build-runtime.mjs';

describe('the exported page’s script', () => {
  it('is built from its source as it is now', async () => {
    const kept = readFileSync(join(import.meta.dirname, '../src/runtime.generated.ts'), 'utf8');
    // If this fails: node plugins/core-export/scripts/build-runtime.mjs
    expect(kept).toBe(await runtimeSource());
  });
});
