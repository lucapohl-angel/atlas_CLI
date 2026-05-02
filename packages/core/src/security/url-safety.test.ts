import { describe, expect, it } from 'vitest';
import { checkUrlSafety } from './url-safety.js';

describe('checkUrlSafety', () => {
  it('rejects non-http schemes', async () => {
    const r = await checkUrlSafety('ftp://example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('URL_BLOCKED');
  });

  it('rejects malformed URLs', async () => {
    const r = await checkUrlSafety('not a url');
    expect(r.ok).toBe(false);
  });

  it('rejects metadata.google.internal regardless of DNS', async () => {
    const r = await checkUrlSafety('http://metadata.google.internal/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('always blocked');
  });

  it('blocks AWS metadata IP even when allowPrivate is true', async () => {
    const r = await checkUrlSafety('http://169.254.169.254/latest/meta-data/', { allowPrivate: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('cloud-metadata');
  });

  it('blocks 127.0.0.1 (loopback)', async () => {
    const r = await checkUrlSafety('http://127.0.0.1/');
    expect(r.ok).toBe(false);
  });

  it('blocks RFC 1918 private (10.x)', async () => {
    const r = await checkUrlSafety('http://10.0.0.1/');
    expect(r.ok).toBe(false);
  });

  it('blocks RFC 1918 private (192.168.x)', async () => {
    const r = await checkUrlSafety('http://192.168.1.1/');
    expect(r.ok).toBe(false);
  });

  it('blocks CGNAT (100.64/10)', async () => {
    const r = await checkUrlSafety('http://100.64.1.1/');
    expect(r.ok).toBe(false);
  });

  it('blocks link-local (169.254/16) other than metadata', async () => {
    const r = await checkUrlSafety('http://169.254.1.1/');
    expect(r.ok).toBe(false);
  });

  it('blocks IPv6 loopback', async () => {
    const r = await checkUrlSafety('http://[::1]/');
    expect(r.ok).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 loopback', async () => {
    const r = await checkUrlSafety('http://[::ffff:127.0.0.1]/');
    expect(r.ok).toBe(false);
  });

  it('allows a public IP literal (8.8.8.8)', async () => {
    const r = await checkUrlSafety('http://8.8.8.8/');
    expect(r.ok).toBe(true);
  });

  it('allows private when allowPrivate is true (and not always-blocked)', async () => {
    const r = await checkUrlSafety('http://10.0.0.1/', { allowPrivate: true });
    expect(r.ok).toBe(true);
  });

  it('rejects unparseable URL with no hostname', async () => {
    const r = await checkUrlSafety('http:///path');
    expect(r.ok).toBe(false);
  });
});
