/**
 * URL safety — SSRF (Server-Side Request Forgery) protection.
 *
 * Resolves the URL's hostname to its actual IP addresses and refuses
 * any address that points at a private/internal network or a cloud
 * metadata endpoint. Without this guard, a tool that fetches arbitrary
 * URLs is a prompt-injection vector for stealing instance credentials
 * (the #1 SSRF target — http://169.254.169.254 returns IAM creds on
 * AWS, GCP, Azure, DigitalOcean, Oracle and Alibaba).
 *
 * Inspired by Hermes' `url_safety.py`. Coverage:
 *   - Cloud metadata IPs (always blocked, no override): 169.254.169.254,
 *     169.254.170.2 (ECS task), 169.254.169.253 (Azure IMDS),
 *     fd00:ec2::254 (IPv6), 100.100.100.200 (Alibaba)
 *   - The whole 169.254.0.0/16 link-local range
 *   - Private (RFC 1918), loopback, link-local, reserved, multicast,
 *     unspecified — via Node's `net` classification + manual checks
 *   - 100.64.0.0/10 CGNAT (RFC 6598) — not covered by Node's `isPrivate`
 *
 * Limitations (documented, not fully fixable at pre-flight level):
 *   - DNS rebinding (TOCTOU): a TTL=0 attacker DNS server could return
 *     a public IP for the check then a private IP for the real fetch.
 *     A connection-level proxy would be required for full coverage.
 *   - Redirect bypass: callers MUST re-validate any redirect target.
 *     `safeFetch` below does this automatically.
 *
 * Fail-closed: any DNS or parse error blocks the request.
 */
import { lookup } from 'node:dns/promises';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

/** Hostnames blocked unconditionally (cloud-metadata DNS shortcuts). */
const ALWAYS_BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog'
]);

/** Specific IPs that are never legitimate agent targets. */
const ALWAYS_BLOCKED_IPS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure / DO / Oracle metadata
  '169.254.170.2',   // AWS ECS task metadata (task IAM creds)
  '169.254.169.253', // Azure IMDS wire server
  'fd00:ec2::254',   // AWS metadata IPv6
  '100.100.100.200'  // Alibaba metadata
]);

/** Parse an IPv4 dotted-quad to a 32-bit number (host byte order). */
const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) + x;
  }
  return n >>> 0;
};

const inRange = (ip: number, prefix: string, bits: number): boolean => {
  const base = ipv4ToInt(prefix);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
};

/** Returns true if the IPv4 address is private/internal/reserved. */
const isPrivateIPv4 = (ip: string): boolean => {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // fail closed
  return (
    inRange(n, '10.0.0.0', 8) ||
    inRange(n, '172.16.0.0', 12) ||
    inRange(n, '192.168.0.0', 16) ||
    inRange(n, '127.0.0.0', 8) ||
    inRange(n, '169.254.0.0', 16) ||
    inRange(n, '100.64.0.0', 10) ||  // CGNAT
    inRange(n, '224.0.0.0', 4) ||    // multicast
    inRange(n, '0.0.0.0', 8) ||      // unspecified
    inRange(n, '240.0.0.0', 4) ||    // reserved/future
    inRange(n, '255.255.255.255', 32)
  );
};

/** Crude IPv6 private/loopback/link-local detection. */
const isPrivateIPv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;       // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('ff')) return true;          // multicast
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped — extract and check
    const v4 = lower.slice('::ffff:'.length);
    return isPrivateIPv4(v4);
  }
  return false;
};

const isAlwaysBlockedIP = (ip: string): boolean => {
  if (ALWAYS_BLOCKED_IPS.has(ip)) return true;
  // Whole 169.254/16 link-local range is never legitimate.
  const n = ipv4ToInt(ip);
  if (n !== null && inRange(n, '169.254.0.0', 16)) return true;
  return false;
};

export interface UrlSafetyOptions {
  /** When true, allow private IP ranges (cloud-metadata still blocked). */
  readonly allowPrivate?: boolean;
}

/**
 * Resolve the URL's hostname and verify every resulting address is
 * safe to fetch. Returns `ok` on success, an `AtlasError` (code
 * `URL_BLOCKED`) on any failure or unsafe target.
 */
export const checkUrlSafety = async (
  url: string,
  opts: UrlSafetyOptions = {}
): Promise<Result<void, AtlasError>> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err(atlasError('URL_BLOCKED', `invalid URL: ${url}`));
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return err(atlasError('URL_BLOCKED', `unsupported scheme: ${scheme}`));
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return err(atlasError('URL_BLOCKED', 'URL has no hostname'));
  if (ALWAYS_BLOCKED_HOSTS.has(hostname)) {
    return err(atlasError('URL_BLOCKED', `hostname always blocked: ${hostname}`));
  }

  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (e) {
    return err(
      atlasError('URL_BLOCKED', `DNS resolution failed for ${hostname}`, {
        cause: e instanceof Error ? e : undefined
      })
    );
  }

  for (const a of addrs) {
    const ip = a.address;
    if (isAlwaysBlockedIP(ip)) {
      return err(atlasError('URL_BLOCKED', `cloud-metadata address blocked: ${hostname} -> ${ip}`));
    }
    if (opts.allowPrivate) continue;
    const priv = a.family === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
    if (priv) {
      return err(atlasError('URL_BLOCKED', `private/internal address blocked: ${hostname} -> ${ip}`));
    }
  }

  return ok(undefined);
};

export interface SafeFetchOptions extends UrlSafetyOptions {
  readonly method?: 'GET' | 'HEAD';
  readonly headers?: Record<string, string>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal;
}

export interface SafeFetchResult {
  readonly status: number;
  readonly url: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly text: string;
}

const DEFAULT_MAX_BYTES = 1_000_000; // 1 MB
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * SSRF-safe HTTP fetcher.
 *
 * Follows redirects manually, re-running `checkUrlSafety` on each hop
 * (so a `Location:` to 169.254.169.254 cannot bypass the guard). Caps
 * the response body and overall time. Always returns a `Result` —
 * never throws for network failures.
 */
export const safeFetch = async (
  url: string,
  opts: SafeFetchOptions = {}
): Promise<Result<SafeFetchResult, AtlasError>> => {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = opts.method ?? 'GET';

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safe = await checkUrlSafety(current, opts);
    if (!safe.ok) return err(safe.error);

    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        headers: opts.headers,
        signal: ac.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      return err(
        atlasError('URL_BLOCKED', `fetch failed: ${e instanceof Error ? e.message : String(e)}`)
      );
    }
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        return err(atlasError('URL_BLOCKED', `redirect without Location header (${res.status})`));
      }
      current = new URL(loc, current).toString();
      continue;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (method === 'HEAD' || !res.body) {
      return ok({
        status: res.status,
        url: current,
        contentType,
        bytes: 0,
        truncated: false,
        text: ''
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let received = 0;
    let truncated = false;
    let buf = '';
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        truncated = true;
        const overshoot = received - maxBytes;
        const slice = value.subarray(0, value.byteLength - overshoot);
        buf += decoder.decode(slice, { stream: false });
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      buf += decoder.decode(value, { stream: true });
    }
    if (!truncated) buf += decoder.decode();

    return ok({
      status: res.status,
      url: current,
      contentType,
      bytes: received,
      truncated,
      text: buf
    });
  }

  return err(atlasError('URL_BLOCKED', `exceeded redirect limit (${maxRedirects})`));
};
