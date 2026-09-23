import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64urlnopad } from '@scure/base';
import {
  SessionError,
  SessionKeyRing,
  fromPublicJwk,
  generateSigningKey,
  issueSession,
  toPublicJwk,
  toVerificationKey,
  verifySession,
  type SessionSubject,
} from '../src/index.js';

const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const subject: SessionSubject = {
  sub: 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3',
  accounts: ['bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3', 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'],
  product: 'console',
  scopes: ['profile', 'orders:read'],
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SessionError) return e.code;
    throw e;
  }
  return 'no-error';
};
const enc = (v: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(v)));
const dec = (s: string) => JSON.parse(new TextDecoder().decode(base64urlnopad.decode(s)));

describe('RFC 8037 A.4 Ed25519 JWS vector', () => {
  it('our EdDSA verifier accepts the RFC signature over the RFC key', () => {
    // https://www.rfc-editor.org/rfc/rfc8037#appendix-A.4
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', kid: 'rfc' };
    const d = base64urlnopad.decode('nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A');
    const jws =
      'eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc.hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg';
    const [h, p, s] = jws.split('.') as [string, string, string];
    const vk = fromPublicJwk(jwk);
    expect(base64urlnopad.encode(ed25519.getPublicKey(d))).toBe(jwk.x);
    expect(ed25519.verify(base64urlnopad.decode(s), new TextEncoder().encode(`${h}.${p}`), vk.publicKey, { zip215: false })).toBe(true);
    expect(base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(`${h}.${p}`), d))).toBe(s);
  });
});

describe('issueSession / verifySession', () => {
  const k1 = generateSigningKey('k1');
  const v1 = toVerificationKey(k1);

  it('round-trips claims with a compact EdDSA JWS', () => {
    const token = issueSession(subject, k1, { now: T0, ttlSeconds: 600 });
    const [h, p, s] = token.split('.') as [string, string, string];
    expect(dec(h)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    expect(base64urlnopad.decode(s)).toHaveLength(64);
    expect(token).not.toMatch(/[=+/]/);
    const claims = verifySession(token, v1, { now: T0 + 1000, audience: 'console' });
    expect(claims).toMatchObject({ ...subject, iss: 'blockspace-id', aud: 'console', iat: T0 / 1000, exp: T0 / 1000 + 600 });
    expect(claims.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(dec(p).jti).toBe(claims.jti);
  });

  it('unique jti per token', () => {
    expect(issueSession(subject, k1)).not.toBe(issueSession(subject, k1));
  });

  it('expires (with configurable leeway)', () => {
    const token = issueSession(subject, k1, { now: T0, ttlSeconds: 60 });
    expect(code(() => verifySession(token, v1, { now: T0 + 60_000 + 29_000 }))).toBe('no-error');
    expect(code(() => verifySession(token, v1, { now: T0 + 90_000 }))).toBe('expired');
    expect(code(() => verifySession(token, v1, { now: T0 + 60_000, leewaySeconds: 0 }))).toBe('expired');
  });

  it('rejects tokens issued in the future', () => {
    const token = issueSession(subject, k1, { now: T0 + 120_000 });
    expect(code(() => verifySession(token, v1, { now: T0 }))).toBe('not_yet_valid');
  });

  it('rejects the wrong key', () => {
    const token = issueSession(subject, k1);
    const imposter = { kid: 'k1', publicKey: toVerificationKey(generateSigningKey('x')).publicKey };
    expect(code(() => verifySession(token, imposter))).toBe('bad_signature');
  });

  it('rejects unknown kids', () => {
    const token = issueSession(subject, k1);
    expect(code(() => verifySession(token, toVerificationKey(generateSigningKey('k2'))))).toBe('unknown_kid');
  });

  it('rejects tampered payloads and headers', () => {
    const token = issueSession(subject, k1, { now: T0 });
    const [h, p, s] = token.split('.') as [string, string, string];
    const escalated = enc({ ...dec(p), scopes: ['admin'] });
    expect(code(() => verifySession(`${h}.${escalated}.${s}`, v1, { now: T0 }))).toBe('bad_signature');
    const flipped = s.slice(0, 10) + (s[10] === 'A' ? 'B' : 'A') + s.slice(11);
    expect(code(() => verifySession(`${h}.${p}.${flipped}`, v1, { now: T0 }))).toBe('bad_signature');
    expect(code(() => verifySession(`${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'k1', x: 1 })}.${p}.${s}`, v1, { now: T0 }))).toBe('bad_signature');
  });

  it('pins alg=EdDSA (no "none", no HS256 confusion)', () => {
    const token = issueSession(subject, k1, { now: T0 });
    const [, p, s] = token.split('.') as [string, string, string];
    expect(code(() => verifySession(`${enc({ alg: 'none', kid: 'k1' })}.${p}.`, v1, { now: T0 }))).toBe('unsupported_alg');
    expect(code(() => verifySession(`${enc({ alg: 'HS256', kid: 'k1' })}.${p}.${s}`, v1, { now: T0 }))).toBe('unsupported_alg');
    expect(code(() => verifySession(`${enc({ alg: 'EdDSA', kid: 'k1', crit: ['exp'] })}.${p}.${s}`, v1, { now: T0 }))).toBe('malformed');
  });

  it('checks issuer, audience and required scopes', () => {
    const token = issueSession(subject, k1, { now: T0, issuer: 'https://id.example.com' });
    expect(code(() => verifySession(token, v1, { now: T0 }))).toBe('wrong_issuer');
    const opts = { now: T0, issuer: 'https://id.example.com' };
    expect(code(() => verifySession(token, v1, { ...opts, audience: 'other' }))).toBe('wrong_audience');
    expect(code(() => verifySession(token, v1, { ...opts, audience: ['other', 'console'] }))).toBe('no-error');
    expect(code(() => verifySession(token, v1, { ...opts, requiredScopes: ['profile'] }))).toBe('no-error');
    expect(code(() => verifySession(token, v1, { ...opts, requiredScopes: ['admin'] }))).toBe('insufficient_scope');
  });

  it.each(['', 'a.b', 'a.b.c.d', '!!.!!.!!', `${'a'.repeat(9000)}.b.c`, 'e30.e30.'])('rejects malformed token %#', (t) => {
    expect(['malformed', 'unsupported_alg', 'unknown_kid']).toContain(code(() => verifySession(t, v1)));
  });

  it('rejects signed payloads with the wrong claim types', () => {
    const header = enc({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    const payload = enc({ iss: 'blockspace-id', aud: 'console', sub: 'x', product: 'console', jti: 'j', accounts: 'x', scopes: [], iat: 1, exp: 2 });
    const sig = base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(`${header}.${payload}`), k1.secretKey));
    expect(code(() => verifySession(`${header}.${payload}.${sig}`, v1, { now: 1000 }))).toBe('malformed');
  });

  it('validates inputs when issuing', () => {
    expect(() => issueSession({ ...subject, product: 'Bad Product' }, k1)).toThrow();
    expect(() => issueSession({ ...subject, sub: '' }, k1)).toThrow();
    expect(() => issueSession(subject, k1, { ttlSeconds: 0 })).toThrow();
    expect(() => issueSession(subject, { kid: 'bad kid!', secretKey: k1.secretKey })).toThrow();
    expect(() => issueSession(subject, { kid: 'k', secretKey: new Uint8Array(16) })).toThrow();
  });
});

describe('key rotation via kid', () => {
  it('old tokens keep verifying after rotation; new tokens use the new kid', () => {
    const ring = new SessionKeyRing(generateSigningKey('2026-09'));
    const old = ring.issue(subject, { now: T0 });
    ring.rotate(generateSigningKey('2026-10'));
    const fresh = ring.issue(subject, { now: T0 });
    expect(dec(fresh.split('.')[0]!).kid).toBe('2026-10');
    expect(ring.verify(old, { now: T0 }).sub).toBe(subject.sub);
    expect(ring.verify(fresh, { now: T0 }).sub).toBe(subject.sub);
    ring.revoke('2026-09');
    expect(code(() => ring.verify(old, { now: T0 }))).toBe('unknown_kid');
    expect(code(() => ring.verify(fresh, { now: T0 }))).toBe('no-error');
  });

  it('retireAt stops accepting tokens minted by the old key after that instant', () => {
    const oldKey = generateSigningKey('a');
    const ring = new SessionKeyRing(oldKey);
    const before = ring.issue(subject, { now: T0 });
    ring.rotate(generateSigningKey('b'), { retireAt: T0 / 1000 + 10 });
    const leaked = issueSession(subject, oldKey, { now: T0 + 60_000 }); // e.g. a stolen old key
    expect(code(() => ring.verify(before, { now: T0 + 60_000 }))).toBe('no-error');
    expect(code(() => ring.verify(leaked, { now: T0 + 60_000 }))).toBe('key_retired');
  });

  it('refuses kid reuse and revoking the active key', () => {
    const ring = new SessionKeyRing(generateSigningKey('a'));
    expect(() => ring.rotate(generateSigningKey('a'))).toThrow();
    expect(() => ring.revoke('a')).toThrow();
  });

  it('publishes a JWKS that verifies tokens', () => {
    const ring = new SessionKeyRing(generateSigningKey('a'));
    ring.rotate(generateSigningKey('b'));
    const jwks = ring.jwks();
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(['a', 'b']);
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const keys = jwks.keys.map(fromPublicJwk);
    expect(verifySession(ring.issue(subject), keys).product).toBe('console');
    expect(verifySession(ring.issue(subject), new Map(keys.map((k) => [k.kid, k]))).product).toBe('console');
    expect(toPublicJwk(keys[0]!).x).toBe(jwks.keys[0]!.x);
    expect(() => fromPublicJwk({ kty: 'EC', crv: 'P-256', x: 'a', kid: 'x' })).toThrow();
  });
});
