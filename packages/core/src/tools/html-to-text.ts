/**
 * Strip a chunk of HTML to readable plain text.
 *
 * This is intentionally minimal — for high-fidelity extraction the
 * caller should use a hosted scraping API (Tavily/Firecrawl/Exa).
 * Operations:
 *   - drop <script>, <style>, <noscript>, <head>, <svg> blocks entirely
 *   - replace <br>, </p>, </div>, </li>, headings with newlines
 *   - strip remaining tags
 *   - decode the common HTML entities
 *   - collapse whitespace
 *
 * Returns at most `maxChars` characters.
 */
const ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '\u00A9',
  reg: '\u00AE',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D'
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const cp = Number.parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = Number.parseInt(d, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&([a-z]+);/gi, (full, name) => ENTITY[String(name).toLowerCase()] ?? full);

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const DROP_BLOCK_RE = /<(script|style|noscript|head|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const NEWLINE_TAGS_RE = /<\/?(p|div|br|li|tr|h[1-6]|ul|ol|section|article|header|footer|nav)[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;

export interface HtmlToTextOptions {
  readonly maxChars?: number;
}

export const htmlToText = (html: string, opts: HtmlToTextOptions = {}): { title: string; text: string; truncated: boolean } => {
  const max = opts.maxChars ?? 50_000;
  const titleMatch = html.match(TITLE_RE);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? '').trim().replace(/\s+/g, ' ') : '';
  let body = html.replace(DROP_BLOCK_RE, ' ');
  body = body.replace(NEWLINE_TAGS_RE, '\n');
  body = body.replace(TAG_RE, ' ');
  body = decodeEntities(body);
  body = body.replace(/\r\n?/g, '\n');
  body = body.replace(/[ \t]+/g, ' ');
  body = body.replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n');
  body = body.replace(/\n{3,}/g, '\n\n');
  body = body.trim();
  if (body.length > max) {
    return { title, text: body.slice(0, max), truncated: true };
  }
  return { title, text: body, truncated: false };
};
