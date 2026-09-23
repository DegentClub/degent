/**
 * Blockspace ID session tokens: compact JWS (RFC 7515) signed with EdDSA / Ed25519 (RFC 8037),
 * JWT claims (RFC 7519). Header: {"alg":"EdDSA","typ":"JWT","kid":...}. Verification pins
 * alg = EdDSA (no "none", no HMAC confusion), selects the key strictly by kid, and checks
 * iss / aud / exp / nbf / iat.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { b64url, fromUtf8, utf8 } from './bytes.js';

export const SESSION_ALG = 'EdDSA';
export const DEFAULT_ISSUER = 'blockspace-id';
const MAX_TOKEN_LENGTH = 8192;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export interface SigningKey {
  kid: string;
  /** 32-byte Ed25519 secret key. Keep in the secret store, never in the repo. */
  secretKey: Uint8Array;
}

export interface VerificationKey {
  kid: string;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** Optional: stop accepting tokens signed by this key after this time (epoch seconds). */
  notAfter?: number;
}

export interface SessionSubject {
  /** Primary wallet address that signed in. */
  sub: string;
  /** All linked wallet addresses (may include sub). */
  accounts: string[];
  /** Product (and JWT audience) the session is for, e.g. a product slug. */
  product: string;
  scopes: string[];
}

export interface SessionClaims extends SessionSubject {
  iss: string;
  aud: string;
  iat: number;
  nbf?: number;
  exp: number;
  jti: string;
}

export interface IssueSessionOptions {
  issuer?: string;
  /** Default: `product`. */
  audience?: string;
  /** Default 3600, max 30 days. */
  ttlSeconds?: number;
  now?: Date | number;
  jti?: string;
}

export interface VerifySessionOptions {
  issuer?: string;
  /** Accepted audience(s). Omit to accept any (not recommended for services). */
  audience?: string | readonly string[];
  now?: Date | number;
  /** Leeway for exp / nbf / iat (default 30s). */
  leewaySeconds?: number;
  /** Required scopes (all must be present). */
  requiredScopes?: readonly string[];
}

export type SessionErrorCode =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'insufficient_scope'
  | 'key_retired';

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

const nowSeconds = (t: Date | number | undefined): number =>
  Math.floor((t === undefined ? Date.now() : typeof t === 'number' ? t : t.getTime()) / 1000);

/** Generate a fresh Ed25519 signing key (for key rotation ceremonies and tests). */
export function generateSigningKey(kid: string): SigningKey {
  if (!KID_RE.test(kid)) throw new Error('invalid kid');
  return { kid, secretKey: ed25519.utils.randomSecretKey() };
}

export function toVerificationKey(k: SigningKey, notAfter?: number): VerificationKey {
  const vk: VerificationKey = { kid: k.kid, publicKey: ed25519.getPublicKey(k.secretKey) };
  if (notAfter !== undefined) vk.notAfter = notAfter;
  return vk;
}

/** Public JWK (RFC 8037) for publishing in a JWKS endpoint. */
export function toPublicJwk(k: VerificationKey): { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg: 'EdDSA'; use: 'sig' } {
  return { kty: 'OKP', crv: 'Ed25519', x: b64url.encode(k.publicKey), kid: k.kid, alg: 'EdDSA', use: 'sig' };
}

export function fromPublicJwk(jwk: { kty?: string; crv?: string; x?: string; kid?: string }): VerificationKey {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || typeof jwk.kid !== 'string')
    throw new Error('not an Ed25519 public JWK');
  const publicKey = b64url.decode(jwk.x);
  if (publicKey.length !== 32) throw new Error('invalid Ed25519 public key');
  return { kid: jwk.kid, publicKey };
}

const encodeJson = (v: unknown): string => b64url.encode(utf8(JSON.stringify(v)));

export function issueSession(subject: SessionSubject, key: SigningKey, opts: IssueSessionOptions = {}): string {
  if (!KID_RE.test(key.kid)) throw new Error('invalid kid');
  if (key.secretKey.length !== 32) throw new Error('secretKey must be 32 bytes');
  if (typeof subject.sub !== 'string' || subject.sub.length === 0) throw new Error('sub required');
  if (!SLUG_RE.test(subject.product)) throw new Error('invalid product');
  const ttl = opts.ttlSeconds ?? 3600;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 30 * 86400) throw new Error('ttlSeconds out of range');
  const iat = nowSeconds(opts.now);
  const claims: SessionClaims = {
    iss: opts.issuer ?? DEFAULT_ISSUER,
    aud: opts.audience ?? subject.product,
    sub: subject.sub,
    accounts: [...subject.accounts],
    product: subject.product,
    scopes: [...subject.scopes],
    iat,
    exp: iat + ttl,
    jti: opts.jti ?? bytesToHex(randomBytes(16)),
  };
  const signingInput = `${encodeJson({ alg: SESSION_ALG, typ: 'JWT', kid: key.kid })}.${encodeJson(claims)}`;
  const sig = ed25519.sign(utf8(signingInput), key.secretKey);
  return `${signingInput}.${b64url.encode(sig)}`;
}

/** A single key, a list, or a map by kid. Rotation: keep old public keys here until their tokens expire. */
export type KeySet = VerificationKey | readonly VerificationKey[] | ReadonlyMap<string, VerificationKey>;

function findKey(keys: KeySet, kid: string): VerificationKey | undefined {
  if (keys instanceof Map) return keys.get(kid);
  const list = Array.isArray(keys) ? (keys as readonly VerificationKey[]) : [keys as VerificationKey];
  return list.find((k) => k.kid === kid);
}

function parseJson(seg: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8(b64url.decode(seg)));
  } catch {
    throw new SessionError('malformed', `${what} is not base64url JSON`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SessionError('malformed', `${what} must be an object`);
  return v as Record<string, unknown>;
}

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Verify a session token. Returns its claims or throws SessionError. */
export function verifySession(token: string, keys: KeySet, opts: VerifySessionOptions = {}): SessionClaims {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) throw new SessionError('malformed', 'token too long');
  const parts = token.split('.');
  if (parts.length !== 3) throw new SessionError('malformed', 'expected three segments');
  const [h, p, s] = parts as [string, string, string];
  const header = parseJson(h, 'header');
  if (header.alg !== SESSION_ALG) throw new SessionError('unsupported_alg', `alg must be ${SESSION_ALG}`);
  if ('crit' in header) throw new SessionError('malformed', 'crit header not supported');
  if (typeof header.kid !== 'string') throw new SessionError('unknown_kid', 'kid missing');
  const key = findKey(keys, header.kid);
  if (!key) throw new SessionError('unknown_kid', 'no key for kid');
  let sig: Uint8Array;
  try {
    sig = b64url.decode(s);
  } catch {
    throw new SessionError('malformed', 'signature is not base64url');
  }
  // zip215:false = strict RFC 8032 verification (rejects non-canonical encodings / malleability).
  let ok = false;
  try {
    ok = sig.length === 64 && ed25519.verify(sig, utf8(`${h}.${p}`), key.publicKey, { zip215: false });
  } catch {
    ok = false;
  }
  if (!ok) throw new SessionError('bad_signature', 'signature verification failed');

  const c = parseJson(p, 'payload');
  if (
    typeof c.iss !== 'string' ||
    typeof c.aud !== 'string' ||
    typeof c.sub !== 'string' ||
    typeof c.product !== 'string' ||
    typeof c.jti !== 'string' ||
    !isStrArray(c.accounts) ||
    !isStrArray(c.scopes) ||
    !isInt(c.iat) ||
    !isInt(c.exp) ||
    (c.nbf !== undefined && !isInt(c.nbf))
  )
    throw new SessionError('malformed', 'claims have the wrong shape');
  const claims = c as unknown as SessionClaims;
  const now = nowSeconds(opts.now);
  const leeway = opts.leewaySeconds ?? 30;
  if (key.notAfter !== undefined && claims.iat > key.notAfter) throw new SessionError('key_retired', 'token issued after key retirement');
  if (now >= claims.exp + leeway) throw new SessionError('expired', 'token expired');
  if (claims.nbf !== undefined && now + leeway < claims.nbf) throw new SessionError('not_yet_valid', 'token not yet valid');
  if (now + leeway < claims.iat) throw new SessionError('not_yet_valid', 'token issued in the future');
  if (claims.iss !== (opts.issuer ?? DEFAULT_ISSUER)) throw new SessionError('wrong_issuer', 'unexpected issuer');
  if (opts.audience !== undefined) {
    const auds = typeof opts.audience === 'string' ? [opts.audience] : opts.audience;
    if (!auds.includes(claims.aud)) throw new SessionError('wrong_audience', 'unexpected audience');
  }
  for (const scope of opts.requiredScopes ?? [])
    if (!claims.scopes.includes(scope)) throw new SessionError('insufficient_scope', `missing scope ${scope}`);
  return claims;
}

/** Signing side of rotation: one active key plus the public keys still accepted. */
export class SessionKeyRing {
  private readonly verification = new Map<string, VerificationKey>();
  private active: SigningKey;

  constructor(active: SigningKey, previous: readonly VerificationKey[] = []) {
    this.active = active;
    for (const k of previous) this.verification.set(k.kid, k);
    this.verification.set(active.kid, toVerificationKey(active));
  }

  get activeKid(): string {
    return this.active.kid;
  }

  /** Make `next` the signing key; the old key keeps verifying (optionally only tokens issued before `retireAt`). */
  rotate(next: SigningKey, opts: { retireAt?: number } = {}): void {
    if (this.verification.has(next.kid)) throw new Error('kid already used');
    const old = this.verification.get(this.active.kid)!;
    if (opts.retireAt !== undefined) this.verification.set(old.kid, { ...old, notAfter: opts.retireAt });
    this.active = next;
    this.verification.set(next.kid, toVerificationKey(next));
  }

  /** Stop accepting a key entirely (after its longest-lived token has expired, or on compromise). */
  revoke(kid: string): void {
    if (kid === this.active.kid) throw new Error('cannot revoke the active key; rotate first');
    this.verification.delete(kid);
  }

  issue(subject: SessionSubject, opts?: IssueSessionOptions): string {
    return issueSession(subject, this.active, opts);
  }

  verify(token: string, opts?: VerifySessionOptions): SessionClaims {
    return verifySession(token, this.verification, opts);
  }

  jwks(): { keys: ReturnType<typeof toPublicJwk>[] } {
    return { keys: [...this.verification.values()].map(toPublicJwk) };
  }
}
