/**
 * Built-in tool: read_file
 *
 * Reads up to `maxBytes` of a UTF-8 file. Path is resolved against the
 * tool context's cwd. Refuses to escape the cwd via `..` for safety.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { ok, err } from '../result.js';
import { truncateForLLM } from './truncate.js';
import type { Tool } from './types.js';

const Input = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(10_000_000).default(200_000)
});

// LLM-facing preview of the file contents inside `summary`. The full
// text up to `maxBytes` is still available in `data.content` for callers
// that want it. Head+tail strategy keeps both ends of the file writes.
const MAX_PREVIEW = 8_000;

/**
 * Module-level read cache keyed on absolute path. We invalidate on
 * mtime *or* size change, so any external write (or our own
 * `write_file` / `edit_file`) safely busts the entry on the next
 * access. Cache is bounded to avoid leaking memory in long sessions.
 *
 * The win: agents commonly re-read the same file across turns; a hit
 * skips the full disk read and the truncation pass. Token cost is
 * unaffected (the model sees the same payload), but turn latency drops
 * noticeably for big files.
 */
interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly maxBytes: number;
  readonly summary: string;
  readonly data: { path: string; bytes: number; truncated: boolean; content: string };
}
const READ_CACHE = new Map<string, CacheEntry>();
const READ_CACHE_MAX = 64;

const cacheGet = (
  abs: string,
  mtimeMs: number,
  size: number,
  maxBytes: number
): CacheEntry | undefined => {
  const e = READ_CACHE.get(abs);
  if (!e) return undefined;
  if (e.mtimeMs !== mtimeMs || e.size !== size || e.maxBytes !== maxBytes) {
    READ_CACHE.delete(abs);
    return undefined;
  }
  return e;
};

const cacheSet = (abs: string, e: CacheEntry): void => {
  if (READ_CACHE.size >= READ_CACHE_MAX) {
    // Drop the oldest entry — Map preserves insertion order.
    const firstKey = READ_CACHE.keys().next().value;
    if (firstKey !== undefined) READ_CACHE.delete(firstKey);
  }
  READ_CACHE.set(abs, e);
};

/** Test/diagnostic hook — clears the read cache. */
export const __clearReadCache = (): void => {
  READ_CACHE.clear();
};

export const readFileTool: Tool<z.infer<typeof Input>> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the project. Path is relative to cwd.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    'Whenever you need to look at the actual contents of a source file, config, README, or test before reasoning about it. Always read before editing — never patch a file blind. Prefer this over `terminal cat` for plain reads (faster, no shell, deterministic truncation).',
  outputContract:
    'On success, `summary` starts with `read <relpath> (<bytes> bytes[, truncated])` followed by a blank line and the file content (preview capped at ~4KB). `data.content` carries the full UTF-8 text up to `maxBytes`.',
  blockedOps: [
    'paths that escape cwd via `..` (refused)',
    'files larger than `maxBytes` (truncated, never errored)'
  ],
  examples: [
    {
      input: '{"path":"package.json"}',
      result: 'returns the file contents'
    },
    {
      input: '{"path":"src/big.log","maxBytes":50000}',
      result: 'reads the first 50000 bytes of a large file'
    }
  ],
  async execute(input, ctx) {
    const abs = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const rel = relative(ctx.cwd, abs);
    if (rel.startsWith('..')) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `path escapes cwd: ${input.path}`, {
          context: { path: input.path, cwd: ctx.cwd }
        })
      );
    }
    try {
      const stats = await stat(abs);
      if (!stats.isFile()) {
        return err(
          atlasError('TOOL_EXECUTION_FAILED', `not a file: ${input.path}`, {
            context: { path: input.path }
          })
        );
      }
      const cached = cacheGet(abs, stats.mtimeMs, stats.size, input.maxBytes);
      if (cached) {
        return ok({ type: 'ok', summary: cached.summary, data: cached.data });
      }
      const buf = await readFile(abs);
      const truncated = buf.byteLength > input.maxBytes;
      const text = buf.subarray(0, input.maxBytes).toString('utf8');
      const preview = truncateForLLM(text, { maxChars: MAX_PREVIEW });
      const summary = `read ${rel || abs} (${buf.byteLength} bytes${truncated ? ', truncated' : ''})\n\n${preview}`;
      const data = { path: abs, bytes: buf.byteLength, truncated, content: text };
      cacheSet(abs, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        maxBytes: input.maxBytes,
        summary,
        data
      });
      return ok({ type: 'ok', summary, data });
    } catch (e) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `failed to read ${input.path}`, {
          cause: e,
          context: { path: input.path }
        })
      );
    }
  }
};
