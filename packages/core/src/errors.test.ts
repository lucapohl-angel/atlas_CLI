import { describe, expect, it } from 'vitest';
import { AtlasError, atlasError, isAtlasError } from './errors.js';

describe('AtlasError', () => {
  it('factory builds an AtlasError with code + message', () => {
    const e = atlasError('TOOL_NOT_FOUND', 'no such tool');
    expect(e).toBeInstanceOf(AtlasError);
    expect(e.code).toBe('TOOL_NOT_FOUND');
    expect(e.message).toBe('no such tool');
    expect(e.recoverable).toBe(true);
  });

  it('preserves additional context', () => {
    const e = atlasError('PROVIDER_RATE_LIMITED', 'slow down', {
      recoverable: true,
      context: { retryAfterMs: 1000 }
    });
    expect(e.context['retryAfterMs']).toBe(1000);
  });

  it('isAtlasError type guard works', () => {
    expect(isAtlasError(atlasError('INTERNAL', 'x'))).toBe(true);
    expect(isAtlasError(new Error('plain'))).toBe(false);
    expect(isAtlasError('string')).toBe(false);
    expect(isAtlasError(null)).toBe(false);
  });

  it('toJSON serializes to a stable shape', () => {
    const e = atlasError('CONFIG_INVALID', 'bad config', {
      cause: new Error('inner'),
      context: { path: '/etc/foo' }
    });
    const json = e.toJSON();
    expect(json.code).toBe('CONFIG_INVALID');
    expect(json.message).toBe('bad config');
    expect(json.cause).toBe('inner');
    expect(json.context?.['path']).toBe('/etc/foo');
  });

  it('preserves prototype chain across instanceof', () => {
    const e = atlasError('INTERNAL', 'x');
    expect(e instanceof AtlasError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });
});
