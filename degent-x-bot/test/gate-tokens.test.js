import { describe, it, expect } from 'vitest';
import { signLinkToken, verifyLinkToken } from '../src/telegram-gate/tokens';

const secret = 's'.repeat(40);

describe('link tokens', () => {
  it('round-trips the telegram id', () => {
    const t = signLinkToken({ tg: 12345 }, { secret, ttlMs: 600_000 });
    const r = verifyLinkToken(t, { secret });
    expect(r.ok).toBe(true);
    expect(r.claims.tg).toBe(12345);
  });

  it('expires after ttl', () => {
    let now = 1_700_000_000_000;
    const t = signLinkToken({ tg: 1 }, { secret, ttlMs: 600_000, now: () => now });
    expect(verifyLinkToken(t, { secret, now: () => now + 599_000 }).ok).toBe(true);
    const late = verifyLinkToken(t, { secret, now: () => now + 601_000 });
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/expired/);
  });

  it('rejects a tampered payload and a wrong secret', () => {
    const t = signLinkToken({ tg: 1 }, { secret, ttlMs: 600_000 });
    const [h, b, s] = t.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ tg: 2, exp: 9_999_999_999 })).toString('base64url');
    expect(verifyLinkToken(`${h}.${forgedBody}.${s}`, { secret }).ok).toBe(false);
    expect(verifyLinkToken(t, { secret: 'x'.repeat(40) }).ok).toBe(false);
    expect(verifyLinkToken(`${h}.${b}`, { secret }).ok).toBe(false);
    expect(verifyLinkToken(undefined, { secret }).ok).toBe(false);
  });

  it('requires a positive integer telegram id', () => {
    const t = signLinkToken({ tg: 'abc' }, { secret, ttlMs: 600_000 });
    expect(verifyLinkToken(t, { secret }).ok).toBe(false);
  });

  it('tokens are unique per call', () => {
    const a = signLinkToken({ tg: 1 }, { secret, ttlMs: 600_000 });
    const b = signLinkToken({ tg: 1 }, { secret, ttlMs: 600_000 });
    expect(a).not.toBe(b);
  });
});
