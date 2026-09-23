import type { MiddlewareHandler } from 'hono';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { errorResponse, setResponseHeader, type ApiKeyPrincipal } from './context.js';

export type ApiKeyEnv = 'live' | 'test';

/** `bsh_live_<base58 of 32 random bytes>` / `bsh_test_...`. The prefix makes leaked keys greppable by secret scanners. */
export const API_KEY_RE = /^bsh_(live|test)_([1-9A-HJ-NP-Za-km-z]{40,50})$/;

export interface ApiKeyRecord {
  id: string;
  /** Lower-case hex SHA-256 of the full key string. The key itself is never stored. */
  hash: string;
  env: ApiKeyEnv;
  scopes: readonly string[];
  ownerId?: string;
  name?: string;
  /** Epoch ms. */
  revokedAt?: number;
  expiresAt?: number;
  /** Per-key quota: at most `limit` requests per fixed `windowMs` window. */
  quota?: { limit: number; windowMs: number };
}

/** Key store port (Postgres table keyed by hash, Redis counters for usage). */
export interface ApiKeyStore {
  findByHash(hash: string): Promise<ApiKeyRecord | undefined>;
  /** Atomically increment and return the request count for (id, window). */
  incrementUsage(id: string, windowStart: number, windowMs: number): Promise<number>;
}

export function hashApiKey(key: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(key)));
}

export function parseApiKey(key: string): { env: ApiKeyEnv } | undefined {
  const m = API_KEY_RE.exec(key);
  return m ? { env: m[1] as ApiKeyEnv } : undefined;
}

/** Mint a key. Show `key` to the user once; persist only `hash` (and `hint` for display). */
export function generateApiKey(env: ApiKeyEnv): { key: string; hash: string; hint: string } {
  let secret = base58.encode(randomBytes(32));
  while (secret.length < 40) secret = `1${secret}`; // leading-zero bytes shorten base58; keep the format stable
  const key = `bsh_${env}_${secret}`;
  return { key, hash: hashApiKey(key), hint: `bsh_${env}_…${secret.slice(-4)}` };
}

/** Constant-time comparison of equal-length strings (length itself is public: both are SHA-256 hex). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly byHash = new Map<string, ApiKeyRecord>();
  private readonly usage = new Map<string, { count: number; expires: number }>();

  add(record: ApiKeyRecord): void {
    if (!/^[0-9a-f]{64}$/.test(record.hash)) throw new Error('hash must be SHA-256 hex');
    this.byHash.set(record.hash, record);
  }

  revoke(id: string, at = Date.now()): void {
    for (const [h, r] of this.byHash) if (r.id === id) this.byHash.set(h, { ...r, revokedAt: at });
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    return this.byHash.get(hash);
  }

  async incrementUsage(id: string, windowStart: number, windowMs: number): Promise<number> {
    const k = `${id}:${windowStart}`;
    if (this.usage.size > 10_000) for (const [key, v] of this.usage) if (v.expires <= windowStart) this.usage.delete(key);
    const e = this.usage.get(k) ?? { count: 0, expires: windowStart + windowMs };
    e.count++;
    this.usage.set(k, e);
    return e.count;
  }
}

export interface ApiKeysOptions {
  store: ApiKeyStore;
  /** Reject requests without a key (default true). With false, anonymous requests pass; a bad key still fails. */
  required?: boolean;
  /** Scopes the key must hold (all of them). */
  scopes?: readonly string[];
  /** Only accept keys of this environment (e.g. 'live' in production). */
  environment?: ApiKeyEnv;
  header?: string;
  now?: () => number;
}

const WWW_AUTH = 'Bearer realm="api", error="invalid_token"';

/**
 * API key authentication. Reads `X-API-Key: bsh_…` or `Authorization: Bearer bsh_…` (other bearer
 * tokens, e.g. session JWTs, are ignored). Only the SHA-256 of the key is looked up and compared
 * (constant time). On success `c.get('apiKey')` holds the principal (never the secret).
 */
export function apiKeys(opts: ApiKeysOptions): MiddlewareHandler {
  const header = opts.header ?? 'X-API-Key';
  const required = opts.required ?? true;
  const requiredScopes = opts.scopes ?? [];
  const now = opts.now ?? Date.now;

  return async (c, next) => {
    let presented = c.req.header(header)?.trim();
    if (!presented) {
      const auth = c.req.header('Authorization');
      const m = auth ? /^Bearer\s+(bsh_\S+)$/i.exec(auth.trim()) : null;
      if (m) presented = m[1];
    }
    if (!presented) {
      if (!required) return next();
      return errorResponse(c, 401, 'missing_api_key', 'API key required', { 'WWW-Authenticate': 'Bearer realm="api"' });
    }
    const invalid = (message = 'Invalid API key') =>
      errorResponse(c, 401, 'invalid_api_key', message, { 'WWW-Authenticate': WWW_AUTH });
    const parsed = parseApiKey(presented);
    if (!parsed) return invalid();
    if (opts.environment && parsed.env !== opts.environment) return invalid(`${parsed.env} keys are not accepted here`);

    const hash = hashApiKey(presented);
    const record = await opts.store.findByHash(hash);
    // Unknown, revoked and expired keys are indistinguishable to the caller.
    const t = now();
    if (!record || !timingSafeEqual(record.hash, hash) || record.env !== parsed.env) return invalid();
    if (record.revokedAt !== undefined && record.revokedAt <= t) return invalid();
    if (record.expiresAt !== undefined && record.expiresAt <= t) return invalid();

    const missing = requiredScopes.filter((s) => !record.scopes.includes(s));
    if (missing.length > 0)
      return errorResponse(c, 403, 'insufficient_scope', `API key lacks scope: ${missing.join(' ')}`, {
        'WWW-Authenticate': `Bearer realm="api", error="insufficient_scope", scope="${requiredScopes.join(' ')}"`,
      });

    let quotaHeaders: Record<string, string> = {};
    if (record.quota) {
      const { limit, windowMs } = record.quota;
      const windowStart = Math.floor(t / windowMs) * windowMs;
      const used = await opts.store.incrementUsage(record.id, windowStart, windowMs);
      const resetS = Math.max(1, Math.ceil((windowStart + windowMs - t) / 1000));
      quotaHeaders = {
        'X-Quota-Limit': String(limit),
        'X-Quota-Remaining': String(Math.max(0, limit - used)),
        'X-Quota-Reset': String(resetS),
      };
      if (used > limit)
        return errorResponse(c, 429, 'quota_exceeded', 'API key quota exceeded', { ...quotaHeaders, 'Retry-After': String(resetS) });
    }

    const principal: ApiKeyPrincipal = { id: record.id, env: record.env, scopes: [...record.scopes] };
    if (record.ownerId !== undefined) principal.ownerId = record.ownerId;
    c.set('apiKey', principal);
    await next();
    for (const [k, v] of Object.entries(quotaHeaders)) setResponseHeader(c, k, v);
  };
}
