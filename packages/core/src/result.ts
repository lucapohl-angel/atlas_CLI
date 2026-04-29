/**
 * Result type — explicit success/failure handling without exceptions.
 *
 * Use Result<T, E> for any operation that can fail in a recoverable way.
 * Reserve thrown exceptions for programmer errors and unrecoverable conditions.
 */

export type Result<T, E = AtlasError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

import type { AtlasError } from './errors.js';

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(
  result: Result<T, E>
): result is { ok: true; value: T } => result.ok;

export const isErr = <T, E>(
  result: Result<T, E>
): result is { ok: false; error: E } => !result.ok;

/**
 * Map the success value of a Result without affecting errors.
 */
export const mapOk = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> => (result.ok ? ok(fn(result.value)) : result);

/**
 * Unwrap the success value or throw the error. Use sparingly — prefer
 * explicit handling. Useful at top-level entry points.
 */
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw result.error;
};
