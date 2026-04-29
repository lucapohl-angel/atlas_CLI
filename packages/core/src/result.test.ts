import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, mapOk, ok, unwrap } from './result.js';
import { atlasError } from './errors.js';

describe('Result', () => {
  it('ok() produces a success Result', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err() produces a failure Result', () => {
    const e = atlasError('INTERNAL', 'boom');
    const r = err(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INTERNAL');
  });

  it('isOk / isErr discriminate correctly', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
    expect(isOk(err(atlasError('INTERNAL', 'x')))).toBe(false);
    expect(isErr(err(atlasError('INTERNAL', 'x')))).toBe(true);
  });

  it('mapOk transforms success values without touching errors', () => {
    expect(mapOk(ok(2), (n) => n * 2)).toEqual(ok(4));
    const e = atlasError('INTERNAL', 'x');
    expect(mapOk(err(e), (n: number) => n * 2)).toEqual(err(e));
  });

  it('unwrap returns the value on success', () => {
    expect(unwrap(ok('hello'))).toBe('hello');
  });

  it('unwrap throws on failure', () => {
    const e = atlasError('INTERNAL', 'fail');
    expect(() => unwrap(err(e))).toThrow('fail');
  });
});
