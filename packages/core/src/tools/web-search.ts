/**
 * Built-in tool: web_search
 *
 * Web search via the Tavily API. Returns ranked results with title,
 * URL, and a short content snippet — same shape Hermes' `web_tools`
 * exposes when configured with the Tavily backend. Free tier is 1000
 * searches/month; sign up at https://tavily.com to get a key, then
 * export `TAVILY_API_KEY` (or set `TAVILY_API_KEY` in the environment
 * Atlas reads at startup).
 *
 * SSRF guard is implicit: we only ever call api.tavily.com.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { Tool } from './types.js';

const Input = z.object({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(10).default(5),
  searchDepth: z.enum(['basic', 'advanced']).default('basic'),
  /** Optional include/exclude domain filters passed straight to Tavily. */
  includeDomains: z.array(z.string().min(1)).max(20).default([]),
  excludeDomains: z.array(z.string().min(1)).max(20).default([])
});

interface TavilyResult {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  readonly score?: number;
}
interface TavilyResponse {
  readonly answer?: string;
  readonly results?: readonly TavilyResult[];
}

export const webSearchTool: Tool<z.infer<typeof Input>> = {
  name: 'web_search',
  description:
    'Search the web via Tavily and return ranked results (title, URL, snippet). Requires TAVILY_API_KEY.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    'Use to discover URLs and recent information you do not already have: package documentation, error messages, library comparisons, news / changelogs, RFCs, version-specific behavior. Prefer this over guessing URLs. Then call `web_fetch` on the most promising result for the full content. For repeated queries that already produced good results, do not re-search — re-use the URLs.',
  outputContract:
    'On success, `summary` is `<n> results for "<query>"` then a blank line then a numbered list of `<title> — <url>\\n  <snippet>` (snippet truncated to ~280 chars). `data` carries `{query, answer?, results: [{title,url,content,score}]}`.',
  blockedOps: [
    'queries longer than 400 chars (rejected by schema)',
    'maxResults > 10 (rejected)',
    'missing TAVILY_API_KEY (returns TOOL_EXECUTION_FAILED with setup hint)'
  ],
  examples: [
    {
      input: '{"query":"how to abort fetch in node 20","maxResults":3}',
      result: 'returns top 3 results with snippets'
    },
    {
      input:
        '{"query":"Zod 4 release notes","searchDepth":"advanced","includeDomains":["github.com","zod.dev"]}',
      result: 'narrower deeper search restricted to two domains'
    }
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) {
      return err(atlasError('TOOL_CANCELLED', 'web_search cancelled'));
    }
    const key = process.env['TAVILY_API_KEY'];
    if (!key) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          'web_search: TAVILY_API_KEY is not set. Get a free key at https://tavily.com and export it before launching Atlas.'
        )
      );
    }
    const body: Record<string, unknown> = {
      api_key: key,
      query: input.query,
      max_results: input.maxResults,
      search_depth: input.searchDepth,
      include_answer: false
    };
    if (input.includeDomains.length > 0) body['include_domains'] = input.includeDomains;
    if (input.excludeDomains.length > 0) body['exclude_domains'] = input.excludeDomains;

    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), 30_000);

    let res: Response;
    try {
      res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `web_search: network error: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }
    clearTimeout(timer);
    if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `web_search: tavily returned ${res.status} ${detail}`)
      );
    }
    let json: TavilyResponse;
    try {
      json = (await res.json()) as TavilyResponse;
    } catch (e) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `web_search: invalid JSON from tavily: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }

    const results = (json.results ?? []).slice(0, input.maxResults);
    const lines: string[] = [`${results.length} results for "${input.query}"`, ''];
    results.forEach((r, i) => {
      const title = (r.title ?? '(no title)').replace(/\s+/g, ' ').trim();
      const url = r.url ?? '';
      const snippet = (r.content ?? '').replace(/\s+/g, ' ').trim();
      const trimmed = snippet.length > 280 ? snippet.slice(0, 280) + '…' : snippet;
      lines.push(`${i + 1}. ${title} — ${url}`);
      if (trimmed) lines.push(`   ${trimmed}`);
    });

    return ok({
      type: 'ok',
      summary: lines.join('\n'),
      data: { query: input.query, ...(json.answer ? { answer: json.answer } : {}), results }
    });
  }
};
