/**
 * Secret-redaction guardrail.
 *
 * Fires on `afterTool` for every tool. Scans the tool's `summary`
 * output for high-confidence secret patterns (provider API keys, JWTs,
 * private keys, generic high-entropy hex/base64 blobs labeled as
 * tokens). Hits are replaced with `[REDACTED:<kind>]` and the modified
 * summary is returned — the model never sees the raw value.
 *
 * `data` payloads are intentionally left alone: tools like `read_file`
 * legitimately need to return file contents verbatim to the caller.
 * Only the model-visible `summary` is rewritten.
 */
import type { ToolOk } from '../../tools/types.js';
import type { HookSpec } from '../types.js';

interface SecretPattern {
  readonly kind: string;
  readonly re: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'aws-secret-key', re: /\b(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])\b(?=.*aws|.*secret)/gi },
  { kind: 'gcp-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'github-pat', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { kind: 'github-server-token', re: /\bghs_[A-Za-z0-9]{36}\b/g },
  { kind: 'github-oauth', re: /\bgho_[A-Za-z0-9]{36}\b/g },
  { kind: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openrouter-key', re: /\bsk-or-v1-[A-Za-z0-9]{40,}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'stripe-key', re: /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{24,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g }
];

export const redactSecrets = (text: string): { redacted: string; hits: number } => {
  let out = text;
  let hits = 0;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, () => {
      hits += 1;
      return `[REDACTED:${kind}]`;
    });
  }
  return { redacted: out, hits };
};

export const secretRedactorHook = (): HookSpec<'afterTool'> => ({
  event: 'afterTool',
  handler: (ctx) => {
    const result = ctx.result;
    if (!('summary' in result) || typeof result.summary !== 'string') {
      return { action: 'allow' };
    }
    const { redacted, hits } = redactSecrets(result.summary);
    if (hits === 0) return { action: 'allow' };
    const next: ToolOk = {
      ...(result as ToolOk),
      summary: redacted
    };
    return { action: 'modify', payload: next };
  }
});
