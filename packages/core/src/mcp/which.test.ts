import { describe, expect, it } from 'vitest';
import { findOnPath } from './which.js';

describe('findOnPath', () => {
  it('finds a definitely-present binary (node)', async () => {
    const p = await findOnPath('node');
    expect(p).not.toBeNull();
    expect(p).toMatch(/node/);
  });

  it('returns null for a clearly absent binary', async () => {
    const p = await findOnPath('atlas-totally-not-a-real-binary-xyz123');
    expect(p).toBeNull();
  });

  it('returns null for empty input', async () => {
    expect(await findOnPath('')).toBeNull();
  });
});
