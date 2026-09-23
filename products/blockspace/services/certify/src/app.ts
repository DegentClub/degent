/**
 * HTTP API: contracts/openapi/blockspace-collections.yaml. Thin: validates path/query input, calls
 * the CertifyService, maps errors to the contract's error codes.
 */
import { Hono } from 'hono';
import { bodyLimit, corsAllowlist, jsonErrorHandler, jsonErrors, jsonNotFound, rateLimit, requestId, securityHeaders, type RateLimitStore } from '@bsh/edge';
import { bytesToHex } from './domain/hash.js';
import { ATTESTATION_TAG, SLUG, type Item, type Snapshot } from './domain/model.js';
import { compareItems } from './domain/stats.js';
import { CertifyService, ServiceError } from './application/certify-service.js';
import type { Clock } from './ports/clock.js';
import type { OrdPort } from './ports/ord.js';
import { adminBearer, httpError } from './http/middleware.js';

export const SERVICE_NAME = 'blockspace-certify';

export interface AppOptions {
  service: CertifyService;
  ord: OrdPort;
  clock: Clock;
  adminToken: string;
  version?: string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  /** Per-IP limits (token bucket). Defaults: reads 600/min, refresh 12/min. */
  rateLimits?: { reads?: { windowMs: number; max: number }; refresh?: { windowMs: number; max: number }; store?: RateLimitStore };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function encodeCursor(last: Pick<Item, 'number' | 'inscriptionId'>): string {
  return Buffer.from(JSON.stringify([last.number, last.inscriptionId]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Pick<Item, 'number' | 'inscriptionId'> {
  const bad = () => httpError(400, 'bad_request', 'invalid cursor');
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(v) || v.length !== 2 || !Number.isSafeInteger(v[0]) || typeof v[1] !== 'string') throw bad();
  return { number: v[0] as number, inscriptionId: v[1] as string };
}

const STATUS: Record<ServiceError['code'], 404 | 409 | 422 | 502> = {
  collection_not_found: 404,
  refresh_in_progress: 409,
  manifest_invalid: 422,
  manifest_not_found: 422,
  parent_not_found: 422,
  upstream_error: 502,
};

function collectionBody(s: Snapshot) {
  return { attestation: s.attestation, digest: s.digest, exclusions: s.exclusions };
}

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  const log = o.log ?? (() => {});
  const signer = o.service.signer;

  const rl = o.rateLimits ?? {};
  const onUnexpected = (err: Error, c: { req: { path: string }; get: (k: 'requestId') => string }) =>
    log('unhandled error', { path: c.req.path, requestId: c.get('requestId'), error: err.message });

  // @bsh/edge stack: every error leaves as { error: { code, message, requestId } }.
  app.onError(jsonErrorHandler({ onUnexpected }));
  app.notFound(jsonNotFound());
  app.use('*', requestId());
  app.use('*', jsonErrors({ onUnexpected }));
  // Public data meant to be embedded anywhere (badges): readable cross-origin.
  app.use('*', securityHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  // Reads are public and CORS-open like the Meter API; `*` never carries credentials, and refresh
  // authenticates with a bearer token a browser would have to be handed explicitly.
  app.use('/v1/*', corsAllowlist(['*'], { allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['authorization', 'content-type'] }));
  /** Domain errors → contract codes (rendered by the edge error handler). */
  const call = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ServiceError) throw httpError(STATUS[e.code], e.code, e.message);
      throw e;
    }
  };
  const readLimit = rateLimit({ ...(rl.reads ?? { windowMs: 60_000, max: 600 }), prefix: 'certify-read', ...(rl.store ? { store: rl.store } : {}) });
  const refreshLimit = rateLimit({ ...(rl.refresh ?? { windowMs: 60_000, max: 12 }), prefix: 'certify-refresh', ...(rl.store ? { store: rl.store } : {}) });

  const slugOf = (raw: string | undefined): string => {
    const slug = raw ?? '';
    if (!SLUG.test(slug)) throw httpError(400, 'bad_request', 'invalid collection slug');
    if (!o.service.collection(slug)) throw httpError(404, 'collection_not_found', `unknown collection ${slug}`);
    return slug;
  };
  const latestOrThrow = async (slug: string): Promise<Snapshot> => {
    const s = await call(o.service.latest(slug));
    if (!s) throw httpError(404, 'not_certified', `collection ${slug} has no attestation yet`);
    return s;
  };

  app.get('/v1/health', readLimit, async (c) => {
    let ord: { ok: boolean; detail?: string };
    try {
      ord = { ok: true, detail: `height ${await o.ord.blockHeight()}` };
    } catch {
      ord = { ok: false, detail: 'ord unreachable' };
    }
    return c.json({
      status: ord.ok ? 'ok' : 'degraded',
      service: SERVICE_NAME,
      version: o.version ?? '0.1.0',
      time: o.clock.now().toISOString(),
      keyId: signer.keyId,
      checks: { ord },
    });
  });

  app.get('/v1/keys', readLimit, (c) => {
    c.header('cache-control', 'public, max-age=300');
    return c.json({
      keys: [
        {
          keyId: signer.keyId,
          algorithm: 'bip340-schnorr-secp256k1',
          publicKey: bytesToHex(signer.publicKey),
          tag: ATTESTATION_TAG,
          status: 'active',
        },
      ],
    });
  });

  app.get('/v1/collections/:slug', readLimit, async (c) => {
    const slug = slugOf(c.req.param('slug'));
    const s = await latestOrThrow(slug);
    c.header('cache-control', 'public, max-age=60');
    return c.json(collectionBody(s));
  });

  app.post('/v1/collections/:slug/refresh', refreshLimit, bodyLimit(1024), adminBearer(o.adminToken), async (c) => {
    const slug = slugOf(c.req.param('slug'));
    const started = Date.now();
    const s = await call(o.service.refresh(slug));
    log('collection refreshed', {
      slug,
      items: s.attestation.stats.itemCount,
      excluded: s.attestation.stats.excludedCount,
      asOfBlockHeight: s.attestation.asOfBlockHeight,
      ms: Date.now() - started,
    });
    return c.json(collectionBody(s));
  });

  app.get('/v1/collections/:slug/items', readLimit, async (c) => {
    const slug = slugOf(c.req.param('slug'));
    const limitRaw = c.req.query('limit');
    let limit = DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      if (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT)
        throw httpError(400, 'bad_request', `limit must be an integer 1..${MAX_LIMIT}`);
      limit = Number(limitRaw);
    }
    const cursorRaw = c.req.query('cursor');
    const after = cursorRaw ? decodeCursor(cursorRaw) : null;
    const s = await latestOrThrow(slug);
    // Items are stored sorted; find the first strictly after the cursor (binary search).
    let lo = 0;
    if (after) {
      let hi = s.items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareItems(s.items[mid]!, after) <= 0) lo = mid + 1;
        else hi = mid;
      }
    }
    const page = s.items.slice(lo, lo + limit);
    const more = lo + limit < s.items.length;
    c.header('cache-control', 'public, max-age=60');
    return c.json({
      slug,
      asOfBlockHeight: s.attestation.asOfBlockHeight,
      itemsDigest: s.attestation.stats.itemsDigest,
      items: page,
      nextCursor: more && page.length ? encodeCursor(page[page.length - 1]!) : null,
    });
  });

  return app;
}
