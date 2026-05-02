/**
 * Built-in tool: web_search
 *
 * Backed exclusively by a local self-hosted SearXNG container. No
 * external API keys, no monthly quotas, no telemetry — your queries
 * never leave the machine.
 *
 * SearXNG is managed via Docker and bound to 127.0.0.1 only. See
 * `searxng-manager.ts` for install / start / stop. The first time
 * the user runs `atlas init` (or `/searxng install` in the TUI) we
 * pull and start the container; afterwards it auto-restarts with
 * Docker.
 *
 * If SearXNG is not reachable, this tool returns a clear setup hint
 * instead of silently failing.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import { resolveSearxngUrl } from './searxng-manager.js';
import type { Tool } from './types.js';

const Input = z.object({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(20).default(8),
  /** Optional include/exclude domain filters applied client-side. */
  includeDomains: z.array(z.string().min(1)).max(20).default([]),
  excludeDomains: z.array(z.string().min(1)).max(20).default([]),
  /** SearXNG categories. Defaults to general; common values: 'general', 'it', 'science'. */
  categories: z.array(z.string().min(1)).max(8).default([]),
  /** Time-window filter, mapped onto SearXNG's `time_range`. */
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
  /** Language code (e.g. 'en', 'de'). Defaults to SearXNG's auto. */
  language: z.string().min(2).max(10).optional()
});

interface SearxResult {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  readonly score?: number;
  readonly engine?: string;
  readonly publishedDate?: string;
}
interface SearxResponse {
  readonly results?: readonly SearxResult[];
  readonly answers?: readonly string[];
  readonly infoboxes?: readonly { content?: string }[];
}

const matchesDomains = (
  url: string,
  include: readonly string[],
  exclude: readonly string[]
): boolean => {
  if (include.length === 0 && exclude.length === 0) return true;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const matchesAny = (list: readonly string[]): boolean =>
    list.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
  if (exclude.length > 0 && matchesAny(exclude)) return false;
  if (include.length > 0 && !matchesAny(include)) return false;
  return true;
};

export const webSearchTool: Tool<z.infer<typeof Input>> = {
  name: 'web_search',
  description:
    'Search the web via a local self-hosted SearXNG container (no API keys, fully private). Aggregates Google, Bing, DuckDuckGo, Wikipedia and others.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    'Use to discover URLs and recent information you do not already have: docs pages, error message references, library comparisons, RFCs, news / changelogs, version-specific behavior. Pair with `web_fetch` to read the most promising hit. If the call returns a setup hint, the SearXNG container is not running — ask the user to start it via `/searxng start` (or run `atlas searxng start`).',
  outputContract:
    'On success, `summary` starts with `<n> results for "<query>" via searxng` then a numbered list of `<title> — <url>\\n  <snippet>` (snippet truncated to ~280 chars). `data` carries `{query, answer?, results: [{title,url,content,score?,engine?}]}`.',
  blockedOps: [
    'queries longer than 400 chars (rejected by schema)',
    'maxResults > 20 (rejected)',
    'SearXNG container not running (returns TOOL_EXECUTION_FAILED with setup hint)'
  ],
  examples: [
    {
      input: '{"query":"how to abort fetch in node 20","maxResults":3}',
      result: 'returns top 3 results from SearXNG'
    },
    {
      input: '{"query":"zod 4 release notes","includeDomains":["github.com","zod.dev"],"timeRange":"month"}',
      result: 'narrower search restricted to two domains and last 30 days'
    },
    {
      input: '{"query":"latest typescript 5.7 features","categories":["it"],"language":"en"}',
      result: 'IT category, English-language results'
    }
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) {
      return err(atlasError('TOOL_CANCELLED', 'web_search cancelled'));
    }

    const urlR = await resolveSearxngUrl();
    if (!urlR.ok) return err(urlR.error);
    const base = urlR.value.replace(/\/$/, '');

    const params = new URLSearchParams({ q: input.query, format: 'json' });
    if (input.categories.length > 0) params.set('categories', input.categories.join(','));
    if (input.timeRange) params.set('time_range', input.timeRange);
    if (input.language) params.set('language', input.language);

    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), 30_000);

    let res: Response;
    try {
      res = await fetch(`${base}/search?${params.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: ac.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `web_search: cannot reach SearXNG at ${base}: ${e instanceof Error ? e.message : String(e)}. Run \`/searxng status\` to diagnose.`
        )
      );
    }
    clearTimeout(timer);
    if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `web_search: SearXNG returned HTTP ${res.status}. ${detail}`
        )
      );
    }

    let json: SearxResponse;
    try {
      json = (await res.json()) as SearxResponse;
    } catch (e) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `web_search: SearXNG returned non-JSON. Make sure JSON is enabled in settings (Atlas-managed containers do this automatically). ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }

    const out: Array<{
      title: string;
      url: string;
      content: string;
      score?: number;
      engine?: string;
    }> = [];
    for (const r of json.results ?? []) {
      if (out.length >= input.maxResults) break;
      const u = r.url ?? '';
      if (!u) continue;
      if (!matchesDomains(u, input.includeDomains, input.excludeDomains)) continue;
      out.push({
        title: (r.title ?? '(no title)').replace(/\s+/g, ' ').trim(),
        url: u,
        content: (r.content ?? '').replace(/\s+/g, ' ').trim(),
        ...(typeof r.score === 'number' ? { score: r.score } : {}),
        ...(r.engine ? { engine: r.engine } : {})
      });
    }

    const answer = (json.answers ?? []).join(' • ').trim() ||
      (json.infoboxes ?? []).map((b) => (b.content ?? '').trim()).filter(Boolean).join(' • ') ||
      undefined;

    const lines: string[] = [`${out.length} results for "${input.query}" via searxng`, ''];
    if (answer) {
      lines.push(`answer: ${answer}`);
      lines.push('');
    }
    out.forEach((r, i) => {
      const snippet = r.content;
      const trimmed = snippet.length > 280 ? snippet.slice(0, 280) + '…' : snippet;
      lines.push(`${i + 1}. ${r.title} — ${r.url}`);
      if (trimmed) lines.push(`   ${trimmed}`);
    });

    return ok({
      type: 'ok',
      summary: lines.join('\n'),
      data: {
        query: input.query,
        ...(answer ? { answer } : {}),
        results: out
      }
    });
  }
};
