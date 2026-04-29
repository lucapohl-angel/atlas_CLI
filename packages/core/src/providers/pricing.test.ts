import { describe, expect, it } from 'vitest';
import { estimateCost, formatCost, priceForModel } from './pricing.js';

describe('priceForModel', () => {
  it('matches an exact key', () => {
    const p = priceForModel('claude-sonnet-4');
    expect(p?.inputPerMTok).toBe(3);
  });

  it('strips an OpenRouter provider prefix', () => {
    const p = priceForModel('anthropic/claude-sonnet-4');
    expect(p?.inputPerMTok).toBe(3);
  });

  it('falls back to longest-prefix match for dated ids', () => {
    const p = priceForModel('claude-sonnet-4-5-20250929');
    expect(p?.inputPerMTok).toBe(3);
  });

  it('returns undefined for unknown models', () => {
    expect(priceForModel('made-up-llm-2099')).toBeUndefined();
  });

  it('is case insensitive', () => {
    expect(priceForModel('GPT-4O')?.inputPerMTok).toBe(2.5);
  });
});

describe('estimateCost', () => {
  it('multiplies input + output by their per-Mtok prices', () => {
    // sonnet-4: $3 in, $15 out per Mtok
    const usd = estimateCost('anthropic/claude-sonnet-4', 1_000_000, 100_000);
    expect(usd).toBeCloseTo(3 + 1.5, 6);
  });

  it('returns undefined for unknown models', () => {
    expect(estimateCost('xyz', 1, 1)).toBeUndefined();
  });
});

describe('formatCost', () => {
  it('uses 4 decimals for sub-cent costs', () => {
    expect(formatCost(0.0042)).toBe('$0.0042');
  });

  it('uses 3 decimals between $0.01 and $1', () => {
    expect(formatCost(0.123)).toBe('$0.123');
  });

  it('uses 2 decimals above $1', () => {
    expect(formatCost(12.345)).toBe('$12.35');
  });
});
