/**
 * Built-in tool: web_fetch
 *
 * SSRF-safe HTTP GET that returns the page's plain-text content.
 * Routes through `safeFetch` so cloud-metadata endpoints, private IP
 * ranges, and CGNAT (100.64/10) are blocked by default. HTML pages
 * are converted to readable text via the local stripper; `text/*`
 * pages are returned verbatim.
 *
 * No API key required. Caps response at 1 MB and 20 s by default.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import { safeFetch } from '../security/url-safety.js';
import { htmlToText } from './html-to-text.js';
import { truncateForLLM } from './truncate.js';
import type { Tool } from './types.js';

const Input = z.object({
  url: z.string().url(),
  maxBytes: z.number().int().positive().max(5_000_000).default(1_000_000),
  // Lowered default from 50_000 → 16_000 chars (~4K tokens) to keep
  // single-page fetches from dominating the prompt cache. Callers that
  // need more can pass `maxChars` explicitly.
  maxChars: z.number().int().positive().max(200_000).default(16_000),
  timeoutMs: z.number().int().positive().max(60_000).default(20_000)
});

export const webFetchTool: Tool<z.infer<typeof Input>> = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its plain-text content. SSRF-guarded: refuses private/internal/cloud-metadata addresses.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    'Use when you have a specific URL (docs page, RFC, blog post, README, error message reference) and need its contents. For open-ended discovery, use `web_search` first to find the URL. Pages over `maxBytes` are truncated, never errored. Binary content (images, PDFs) is returned as-is for `text/*` and otherwise reported with status + content-type only.',
  outputContract:
    'On success, `summary` starts with `GET <url> -> <status>` then `title:` (when present) then a blank line then the extracted plain text (capped at `maxChars`). `data` carries `{status, finalUrl, contentType, bytes, truncated, title, text}`.',
  blockedOps: [
    'private/internal/loopback IPs (RFC1918, 127/8, link-local, CGNAT)',
    'cloud-metadata IPs (169.254.169.254, etc.) — always blocked',
    'non-http(s) schemes',
    'redirect loops past 5 hops'
  ],
  examples: [
    {
      input: '{"url":"https://example.com"}',
      result: 'returns the page title + plain-text body'
    },
    {
      input: '{"url":"https://docs.python.org/3/library/asyncio.html","maxChars":20000}',
      result: 'extracts the docs page truncated to ~20KB of text',
      note: 'For repeated reads of the same site, prefer copying the relevant section into the conversation rather than re-fetching.'
    }
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) {
      return err(atlasError('TOOL_CANCELLED', 'web_fetch cancelled'));
    }
    const fetched = await safeFetch(input.url, {
      method: 'GET',
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: {
        'user-agent': 'Atlas-OS/0.1 (+https://github.com/lucapohl-angel/atlas_CLI)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
      }
    });
    if (!fetched.ok) return err(fetched.error);

    const { status, url: finalUrl, contentType, bytes, truncated, text } = fetched.value;
    const ct = contentType.toLowerCase();
    const isHtml = ct.includes('html') || ct.includes('xml');
    const isText = ct.startsWith('text/') || ct.includes('json') || ct.includes('javascript');

    let title = '';
    let body = '';
    if (isHtml && text) {
      const r = htmlToText(text, { maxChars: input.maxChars });
      title = r.title;
      body = r.text;
    } else if (isText) {
      body = truncateForLLM(text, { maxChars: input.maxChars });
    } else {
      body = `(non-text response, ${bytes} bytes)`;
    }

    const lines: string[] = [`GET ${finalUrl} -> ${status} (${ct || 'unknown'}, ${bytes} bytes${truncated ? ', truncated' : ''})`];
    if (title) lines.push(`title: ${title}`);
    lines.push('');
    lines.push(body);

    return ok({
      type: 'ok',
      summary: lines.join('\n'),
      data: { status, finalUrl, contentType, bytes, truncated, title, text: body }
    });
  }
};
