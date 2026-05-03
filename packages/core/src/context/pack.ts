/**
 * Context Pack loader (Six-File Context System).
 *
 * Reads the four scaffolded files under `<cwd>/context/` and returns a
 * single composed string ready to splice into the active agent's
 * system prompt. The pack is intentionally:
 *
 *   - **Static across a session** (apart from the tracker tail) so the
 *     Anthropic provider's `cache_control` on the system block earns a
 *     full prefix-cache hit on every turn.
 *   - **Bounded in size**: per-file head cap (default 12 KB) so a
 *     runaway tracker can't blow the system prompt.
 *   - **Best-effort**: any missing file is silently skipped. Hosts are
 *     expected to call `loadContextPack` on every turn (cheap — file
 *     reads only) and treat absence as "no pack scaffolded yet".
 *
 * For the volatile tracker file we keep only the **tail** (the most
 * recent ~80 lines, where the auto-tracker hook appends decisions and
 * open questions). Older history lives in git.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ContextPackOptions {
  readonly cwd: string;
  /**
   * Max bytes per source file before truncation. Defaults to 12 KB —
   * enough for a one-page doc, small enough that all four files plus
   * the tracker tail stay well under 64 KB combined.
   */
  readonly maxBytesPerFile?: number;
  /** Tail line count for `progress-tracker.md`. Defaults to 80. */
  readonly trackerTailLines?: number;
}

interface PackFile {
  readonly relPath: string;
  readonly heading: string;
  /** When true, only include the last `trackerTailLines` of the file. */
  readonly tailOnly?: boolean;
}

const PACK_FILES: readonly PackFile[] = [
  { relPath: 'context/project-overview.md', heading: 'Project Overview' },
  { relPath: 'context/code-standards.md', heading: 'Code Standards' },
  { relPath: 'context/ai-workflow-rules.md', heading: 'AI Workflow Rules' },
  { relPath: 'context/progress-tracker.md', heading: 'Progress Tracker (tail)', tailOnly: true }
];

const DEFAULT_MAX_BYTES = 12 * 1024;
const DEFAULT_TAIL_LINES = 80;

const readBounded = async (
  abs: string,
  maxBytes: number,
  tailOnly: boolean,
  tailLines: number
): Promise<string | undefined> => {
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
  let body = raw;
  if (tailOnly) {
    const lines = body.split('\n');
    if (lines.length > tailLines) {
      body = lines.slice(-tailLines).join('\n');
    }
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    // Head + tail truncation — keep the start (heading + intent) and
    // the end (most recent rows for the tracker).
    const half = Math.floor(maxBytes / 2);
    const head = body.slice(0, half);
    const tail = body.slice(-half);
    body = `${head}\n\n... [context-pack truncated to ${maxBytes} bytes] ...\n\n${tail}`;
  }
  return body;
};

/**
 * Result of a pack load. `content` is undefined when no files were
 * found — hosts should treat that as "skip injection".
 */
export interface ContextPack {
  readonly content?: string;
  readonly filesRead: readonly string[];
  readonly bytes: number;
}

export const loadContextPack = async (opts: ContextPackOptions): Promise<ContextPack> => {
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const tailLines = opts.trackerTailLines ?? DEFAULT_TAIL_LINES;

  const blocks: string[] = [];
  const filesRead: string[] = [];
  let bytes = 0;

  for (const f of PACK_FILES) {
    const body = await readBounded(
      join(opts.cwd, f.relPath),
      maxBytes,
      f.tailOnly === true,
      tailLines
    );
    if (body === undefined || body.trim().length === 0) continue;
    blocks.push(`### ${f.heading} (\`${f.relPath}\`)\n\n${body.trim()}`);
    filesRead.push(f.relPath);
    bytes += Buffer.byteLength(body, 'utf8');
  }

  if (blocks.length === 0) {
    return { filesRead: [], bytes: 0 };
  }

  const intro =
    'The following files form the project Context Pack — the canonical answer to "what is this project, what conventions hold, and where are we right now?". Treat them as authoritative. When in doubt, resolve against these before guessing.';

  const content = `## Project Context Pack\n\n${intro}\n\n${blocks.join('\n\n')}`;
  return { content, filesRead, bytes };
};
