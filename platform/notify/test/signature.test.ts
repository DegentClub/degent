import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, parseSignatureHeader, signWebhookPayload, verifyWebhookSignature } from '../src/index.js';

const SECRET = 'whsec_test_1';
const body = JSON.stringify({ specversion: '1.0', id: 'e1', type: 'collection.minted', data: { n: 1 } });
const T = 1_790_000_000;

describe('webhook signing', () => {
  it('produces t=…,v1=HMAC-SHA256(secret, "t.body")', () => {
    const h = signWebhookPayload(body, SECRET, T);
    const expected = createHmac('sha256', SECRET).update(`${T}.${body}`).digest('hex');
    expect(h).toBe(`t=${T},v1=${expected}`);
    expect(computeSignature(new TextEncoder().encode(body), SECRET, T)).toBe(expected);
  });

  it('verifies a valid signature within tolerance (string and bytes body)', () => {
    const h = signWebhookPayload(body, SECRET, T);
    expect(verifyWebhookSignature(body, h, SECRET, 300, T + 299)).toEqual({ ok: true, timestamp: T });
    expect(verifyWebhookSignature(Buffer.from(body), h, SECRET, 300, T).ok).toBe(true);
  });

  it.each([
    ['tampered body', body.replace('"n":1', '"n":2'), (h: string) => h, 'signature_mismatch'],
    ['tampered timestamp', body, (h: string) => h.replace(`t=${T}`, `t=${T + 1}`), 'signature_mismatch'],
    ['tampered signature', body, (h: string) => h.slice(0, -1) + (h.endsWith('0') ? '1' : '0'), 'signature_mismatch'],
    ['whitespace-reserialised body', JSON.stringify(JSON.parse(body), null, 1), (h: string) => h, 'signature_mismatch'],
    ['missing header', body, () => '', 'malformed_header'],
    ['garbage header', body, () => 'hello', 'malformed_header'],
    ['no v1', body, () => `t=${T},v0=abc`, 'no_v1_signature'],
  ])('rejects %s', (_n, b, mutate, reason) => {
    const h = mutate(signWebhookPayload(body, SECRET, T));
    expect(verifyWebhookSignature(b, h, SECRET, 300, T)).toEqual({ ok: false, reason });
  });

  it('rejects the wrong secret', () => {
    expect(verifyWebhookSignature(body, signWebhookPayload(body, 'other', T), SECRET, 300, T)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects replays outside the window and far-future timestamps', () => {
    const h = signWebhookPayload(body, SECRET, T);
    expect(verifyWebhookSignature(body, h, SECRET, 300, T + 301)).toEqual({ ok: false, reason: 'timestamp_too_old' });
    expect(verifyWebhookSignature(body, h, SECRET, 300, T - 301)).toEqual({ ok: false, reason: 'timestamp_in_future' });
    expect(verifyWebhookSignature(body, h, SECRET, 3600, T + 301).ok).toBe(true);
  });

  it('supports secret rotation on both sides', () => {
    const h = signWebhookPayload(body, ['new', 'old'], T);
    expect(parseSignatureHeader(h)!.v1).toHaveLength(2);
    expect(verifyWebhookSignature(body, h, 'old', 300, T).ok).toBe(true);
    expect(verifyWebhookSignature(body, h, 'new', 300, T).ok).toBe(true);
    expect(verifyWebhookSignature(body, signWebhookPayload(body, 'old', T), ['new', 'old'], 300, T).ok).toBe(true);
  });

  it('ignores unknown schemes and validates inputs', () => {
    const h = `${signWebhookPayload(body, SECRET, T)},v2=zzz`;
    expect(verifyWebhookSignature(body, h, SECRET, 300, T).ok).toBe(true);
    expect(() => signWebhookPayload(body, '', T)).toThrow();
    expect(() => signWebhookPayload(body, SECRET, 1.5)).toThrow();
    expect(parseSignatureHeader(`t=1,t=2,v1=${'a'.repeat(64)}`)).toBeNull();
  });
});
