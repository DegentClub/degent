/**
 * HTTP API (contracts/openapi/degent-studio.yaml). Thin: @bsh/edge middleware, bearer session auth,
 * API keys with scopes, request parsing, StudioService calls, structured errors. No secrets in any
 * response or log line.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import {
  apiKeys,
  bodyLimit,
  corsAllowlist,
  jsonErrorHandler,
  jsonErrors,
  jsonNotFound,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
  type ApiKeyStore,
} from '@bsh/edge';
import type { SessionClaims } from '@bsh/identity';
import { ANONYMOUS, type StudioService, type Viewer } from './application/studio-service.js';
import type { Logger } from './application/logger.js';
import { silentLogger } from './application/logger.js';
import { ARTWORK_ID } from './domain/artwork.js';
import { DomainError, StaleWriteError } from './domain/errors.js';
import type { Clock } from './ports/clock.js';

export interface AppOptions {
  service: StudioService;
  apiKeyStore: ApiKeyStore;
  /** Only accept keys of this environment (`live` on mainnet). */
  apiKeyEnvironment?: 'live' | 'test';
  clock: Clock;
  /** Exact origins allowed for browser calls. Empty = deny all cross-origin browser calls. */
  corsOrigins: string[];
  /** CIDRs of proxies we run; X-Forwarded-For is only honoured behind them. */
  trustedProxies?: string[];
  /** Mutating requests per client IP per minute. */
  rateLimitPerMinute?: number;
  log?: Logger;
}

export const JSON_BODY_LIMIT = 16 * 1024;
export const SCOPE_REVIEW = 'studio:review';
export const SCOPE_INTERNAL = 'studio:internal';
const IMMUTABLE = 'public, max-age=31536000, immutable';

declare module 'hono' {
  interface ContextVariableMap {
    session: SessionClaims;
  }
}

/** Hono wants an ArrayBuffer-backed view; copy only if the bytes sit on a SharedArrayBuffer. */
const asBody = (b: Uint8Array): Uint8Array<ArrayBuffer> => (b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : new Uint8Array(b));

function errorJson(c: Context, e: DomainError): Response {
  const body = { error: { code: e.code, message: e.message, requestId: c.get('requestId') ?? null, ...(e.details === undefined ? {} : { details: e.details }) } };
  return c.json(body, e.status as 400);
}

async function readJson(c: Context): Promise<unknown> {
  const ct = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw new DomainError('unsupported_media_type', 415, 'content-type must be application/json');
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('bad_request', 400, 'body is not valid JSON');
  }
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v === etag || v === `W/${etag}`;
  });
}

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  const log = o.log ?? silentLogger;
  const svc = o.service;
  const now = () => o.clock.now().getTime();

  const onUnexpected = (err: Error, c: Context) => log.error('unhandled error', { path: c.req.path, requestId: c.get('requestId'), error: err.message });
  const edgeOnError = jsonErrorHandler({ onUnexpected });
  // Domain errors carry `details`, which the edge renderer drops. Hono records a caught error on
  // `c.error` and jsonErrors() would re-render it, so clear it once we have rendered it ourselves.
  app.onError((err, c) => {
    if (err instanceof DomainError) {
      c.error = undefined;
      return errorJson(c, err);
    }
    if (err instanceof StaleWriteError) {
      c.error = undefined;
      return errorJson(c, new DomainError('conflict', 409, 'the record changed concurrently; fetch it and retry'));
    }
    return edgeOnError(err, c);
  });
  app.notFound(jsonNotFound());
  app.use(requestId());
  app.use(jsonErrors({ onUnexpected }));
  // CORP cross-origin: approved artwork bytes are embedded by the degent.club front end.
  app.use(securityHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use(
    corsAllowlist(o.corsOrigins, {
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'If-None-Match'],
      exposeHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'Content-Length', 'ETag'],
    }),
  );
  if (o.trustedProxies?.length) app.use(trustProxy({ trusted: o.trustedProxies }));
  const limiter = rateLimit({ windowMs: 60_000, max: o.rateLimitPerMinute ?? 60, prefix: 'ip', now });
  app.use('*', (c, next) => (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS' ? next() : limiter(c, next)));

  const keyEnv = o.apiKeyEnvironment ? { environment: o.apiKeyEnvironment } : {};
  const reviewer = apiKeys({ store: o.apiKeyStore, scopes: [SCOPE_REVIEW], ...keyEnv });
  const internal = apiKeys({ store: o.apiKeyStore, scopes: [SCOPE_INTERNAL], ...keyEnv });
  /** Optional API key on public reads: a presented key must be valid, but none is required. */
  const optionalKey = apiKeys({ store: o.apiKeyStore, required: false, ...keyEnv });

  const authed: MiddlewareHandler = async (c, next) => {
    c.set('session', await svc.authenticate(c.req.header('authorization')));
    await next();
  };

  /** Anonymous, artist session or API key principal (after `optionalKey`). */
  const viewerOf = async (c: Context): Promise<Viewer> => {
    const key = c.get('apiKey');
    if (key) return { kind: 'apiKey', id: key.id, scopes: key.scopes };
    const auth = c.req.header('authorization');
    if (!auth) return ANONYMOUS;
    const claims = await svc.authenticate(auth);
    return { kind: 'artist', address: claims.sub };
  };

  const artworkId = (c: Context): string => {
    const id = c.req.param('id') ?? '';
    if (!ARTWORK_ID.test(id)) throw new DomainError('not_found', 404, 'artwork not found');
    return id;
  };
  const jsonBody = bodyLimit(JSON_BODY_LIMIT);

  // ---------------------------------------------------------------- service
  app.get('/v1/health', async (c) => c.json(await svc.health()));
  app.get('/v1/config', (c) => c.json(svc.config()));

  // ---------------------------------------------------------------- auth
  app.post('/v1/auth/challenge', jsonBody, async (c) => c.json(await svc.challenge(await readJson(c)), 201));
  app.post('/v1/auth/verify', jsonBody, async (c) => c.json(await svc.verify(await readJson(c))));

  // ---------------------------------------------------------------- artists (literal routes before the :address one)
  app.get('/v1/artists/me', authed, async (c) => c.json(await svc.me(c.get('session').sub)));
  app.put('/v1/artists/me', jsonBody, authed, async (c) => c.json(await svc.updateMe(c.get('session').sub, await readJson(c))));
  app.get('/v1/artists/me/royalties', authed, async (c) => c.json(await svc.royalties(c.get('session').sub, c.req.query())));
  app.get('/v1/artists/:address', async (c) => c.json(await svc.publicArtist(c.req.param('address'))));

  // ---------------------------------------------------------------- artworks
  app.get('/v1/artworks', optionalKey, async (c) => c.json(await svc.listArtworks(c.req.query(), await viewerOf(c))));
  app.post('/v1/artworks', jsonBody, authed, async (c) => c.json(await svc.createArtwork(c.get('session').sub, await readJson(c)), 201));
  app.get('/v1/artworks/:id', optionalKey, async (c) => c.json(await svc.getArtwork(artworkId(c), await viewerOf(c))));
  app.delete('/v1/artworks/:id', authed, async (c) => c.json(await svc.delist(artworkId(c), c.get('session').sub)));

  app.put('/v1/artworks/:id/content', bodyLimit(svc.settings.maxUploadBytes), async (c) => {
    const id = artworkId(c);
    const ct = (c.req.header('content-type') ?? '').toLowerCase().split(';')[0]!.trim();
    // Authorise before reading up to 4 MiB of body.
    await svc.authorizeUpload(id, c.req.header('authorization'));
    if (ct !== 'application/octet-stream') throw new DomainError('unsupported_media_type', 415, 'content-type must be application/octet-stream');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await svc.uploadContent(id, c.req.header('authorization'), bytes));
  });

  // Approved bytes are public and immutable: content-addressed, so the ETag is the sha256.
  app.get('/v1/artworks/:id/content', async (c) => {
    const { bytes, contentType, sha256 } = await svc.getContent(artworkId(c));
    const etag = `"${sha256}"`;
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304, { etag, 'cache-control': IMMUTABLE });
    return c.body(asBody(bytes), 200, {
      'content-type': contentType,
      'content-length': String(bytes.length),
      'cache-control': IMMUTABLE,
      etag,
      'content-disposition': `inline; filename="degent-${sha256.slice(0, 12)}"`,
    });
  });

  app.post('/v1/artworks/:id/review', jsonBody, reviewer, async (c) => c.json(await svc.houseReview(artworkId(c), c.get('apiKey').id, await readJson(c))));
  app.post('/v1/artworks/:id/feature', jsonBody, reviewer, async (c) => c.json(await svc.feature(artworkId(c), c.get('apiKey').id, await readJson(c))));

  // ---------------------------------------------------------------- internal (mint service)
  app.get('/v1/internal/artists/:address/payout', internal, async (c) => c.json(await svc.artistPayout(c.req.param('address'))));
  app.post('/v1/internal/royalties', jsonBody, internal, async (c) => {
    const r = await svc.recordRoyalty(await readJson(c));
    return c.json(r, r.created ? 201 : 200);
  });

  return app;
}
