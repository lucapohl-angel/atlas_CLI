import { describe, expect, it } from 'vitest';
import {
  BridgeRequestSchema,
  BridgeResponseSchema,
  BridgeStreamEventSchema,
  createBridgeErrorResponse,
  createBridgeResponse,
  requestIdFromUnknown,
} from './bridge.js';

describe('VS Code bridge', () => {
  it('accepts a ping request', () => {
    const parsed = BridgeRequestSchema.safeParse({
      requestId: 'req-1',
      kind: 'ping',
      params: {},
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects unknown request kinds', () => {
    const parsed = BridgeRequestSchema.safeParse({
      requestId: 'req-1',
      kind: 'readSecrets',
      params: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts provider-shaped stream events', () => {
    const parsed = BridgeStreamEventSchema.safeParse({
      type: 'delta',
      text: 'hello',
    });

    expect(parsed.success).toBe(true);
  });

  it('creates typed responses', () => {
    expect(BridgeResponseSchema.safeParse(createBridgeResponse('req-1', { ok: true })).success).toBe(true);
    expect(BridgeResponseSchema.safeParse(createBridgeErrorResponse('req-2', 'Nope', 'NOT_READY')).success).toBe(true);
  });

  it('extracts request ids from unknown messages', () => {
    expect(requestIdFromUnknown({ requestId: 'req-1' })).toBe('req-1');
    expect(requestIdFromUnknown({ requestId: 123 })).toBeUndefined();
    expect(requestIdFromUnknown(null)).toBeUndefined();
  });
});
