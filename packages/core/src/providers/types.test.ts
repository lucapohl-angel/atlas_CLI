import { describe, expect, it } from 'vitest';
import { contentToString, isContentBlocks } from './types.js';

describe('contentToString', () => {
  it('returns the string unchanged for plain text', () => {
    expect(contentToString('hello world')).toBe('hello world');
  });

  it('concatenates text blocks and ignores images', () => {
    const blocks = [
      { type: 'text' as const, text: 'Look at this: ' },
      { type: 'image' as const, base64: 'abc123', mediaType: 'image/png' },
      { type: 'text' as const, text: 'What do you see?' },
    ];
    expect(contentToString(blocks)).toBe('Look at this: What do you see?');
  });

  it('returns empty string for image-only blocks', () => {
    const blocks = [{ type: 'image' as const, base64: 'abc123', mediaType: 'image/png' }];
    expect(contentToString(blocks)).toBe('');
  });
});

describe('isContentBlocks', () => {
  it('returns false for a plain string', () => {
    expect(isContentBlocks('hello')).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(isContentBlocks([])).toBe(false);
  });

  it('returns true for a valid content block array', () => {
    expect(isContentBlocks([{ type: 'text', text: 'hi' }])).toBe(true);
    expect(
      isContentBlocks([
        { type: 'text', text: 'hi' },
        { type: 'image', base64: 'abc', mediaType: 'image/png' },
      ])
    ).toBe(true);
  });

  it('returns false for arrays with invalid blocks', () => {
    expect(isContentBlocks([{ type: 'video', url: 'http://example.com' }])).toBe(false);
    // Note: isContentBlocks is a lightweight guard that only checks the `type` discriminant,
    // not the presence of all required fields. Full validation is done by Zod at boundaries.
    expect(isContentBlocks([{ type: 'text' }])).toBe(true);
  });
});
