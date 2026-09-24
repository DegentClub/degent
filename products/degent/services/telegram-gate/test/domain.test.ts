import { describe, expect, it } from 'vitest';
import { addressKey, isVerifiableAddress } from '../src/domain/address.js';
import { signLinkToken, verifyLinkToken } from '../src/domain/link-token.js';
import { SlidingWindowLimiter } from '../src/domain/rate-limit.js';
import { ADMIN_STATEMENT, gateStatement, telegramIdOfStatement } from '../src/domain/statement.js';

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000_000;

describe('link token', () => {
  it('round-trips the Telegram id with an expiry and a jti', () => {
    const t = signLinkToken(12345, { secret: SECRET, ttlSeconds: 600, now: NOW });
    const r = verifyLinkToken(t, { secret: SECRET, now: NOW });
    expect(r).toEqual({ ok: true, claims: { tg: 12345, exp: NOW / 1000 + 600, jti: expect.stringMatching(/^[0-9a-f]{16}$/) } });
  });

  it('has the shape the /verify page accepts (no dots, 8..128 url-safe chars)', () => {
    const t = signLinkToken(Number.MAX_SAFE_INTEGER, { secret: SECRET, ttlSeconds: 600, now: NOW });
    expect(t).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(t).toHaveLength(50);
  });

  it('two links for the same user differ (random jti)', () => {
    const a = signLinkToken(1, { secret: SECRET, ttlSeconds: 600, now: NOW });
    const b = signLinkToken(1, { secret: SECRET, ttlSeconds: 600, now: NOW });
    expect(a).not.toBe(b);
  });

  it('expires', () => {
    const t = signLinkToken(1, { secret: SECRET, ttlSeconds: 600, now: NOW });
    expect(verifyLinkToken(t, { secret: SECRET, now: NOW + 599_000 }).ok).toBe(true);
    expect(verifyLinkToken(t, { secret: SECRET, now: NOW + 600_000 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects another secret and any flipped byte', () => {
    const t = signLinkToken(1, { secret: SECRET, ttlSeconds: 600, now: NOW });
    expect(verifyLinkToken(t, { secret: 'x'.repeat(40), now: NOW })).toEqual({ ok: false, reason: 'bad_mac' });
    const raw = Buffer.from(t, 'base64url');
    for (const i of [0, 3, 10, 15, 30, 36]) {
      const copy = Buffer.from(raw);
      copy[i] = copy[i]! ^ 1;
      expect(verifyLinkToken(copy.toString('base64url'), { secret: SECRET, now: NOW }).ok, `byte ${i}`).toBe(false);
    }
  });

  it.each([undefined, 42, '', 'a.b.c', 'short', 'A'.repeat(200), '%%%%%%%%%%'])('rejects the malformed token %j', (t) => {
    expect(verifyLinkToken(t, { secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses to sign for an invalid Telegram id or without a secret', () => {
    expect(() => signLinkToken(0, { secret: SECRET, ttlSeconds: 1, now: NOW })).toThrow();
    expect(() => signLinkToken(1, { secret: '', ttlSeconds: 1, now: NOW })).toThrow();
  });
});

describe('statements', () => {
  it('bind the Telegram user id and round-trip', () => {
    expect(gateStatement(42)).toBe('Prove I hold a Degent to join the degent.club holders group as Telegram user 42. No transaction, no fees.');
    expect(telegramIdOfStatement(gateStatement(42))).toBe(42);
    expect(telegramIdOfStatement(gateStatement(7_123_456_789))).toBe(7_123_456_789);
  });

  it('do not parse other text', () => {
    expect(telegramIdOfStatement(ADMIN_STATEMENT)).toBeNull();
    expect(telegramIdOfStatement(gateStatement(42).replace('42', '042'))).toBeNull();
    expect(telegramIdOfStatement(`${gateStatement(42)} `)).toBeNull();
  });

  it('are single printable lines (the SIWB statement grammar)', () => {
    for (const s of [gateStatement(1), ADMIN_STATEMENT]) expect(s).toMatch(/^[^\x00-\x1f\x7f]{1,280}$/u);
  });
});

describe('addresses', () => {
  it.each([
    ['bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3', true],
    ['bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l', true],
    ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', true],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', true],
    ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', false],
    ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', false], // p2wsh: no single key to prove
    ['0xdeadbeef', false],
    ['', false],
  ])('isVerifiableAddress(%j) on mainnet = %s', (a, ok) => {
    expect(isVerifiableAddress(a, 'mainnet')).toBe(ok);
  });

  it('folds bech32 case but keeps base58 case', () => {
    expect(addressKey('BC1QABC')).toBe('bc1qabc');
    expect(addressKey('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows max hits per window per key, refusals are not counted', () => {
    const l = new SlidingWindowLimiter(2, 1000);
    expect([l.hit('a', 0), l.hit('a', 10), l.hit('a', 20), l.hit('b', 20)]).toEqual([true, true, false, true]);
    expect(l.hit('a', 1001)).toBe(true); // the first hit left the window
    expect(l.hit('a', 1005)).toBe(false);
  });
});
