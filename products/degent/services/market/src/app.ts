/**
 * HTTP API (contracts/openapi/degent-market.yaml). Thin: limits and parses requests, gates buys, calls
 * the MarketService, maps domain errors to structured JSON errors. No PSBT signatures, challenge
 * messages or keys in any log line; the seller's signature never appears in any response.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { ApiErrorBody } from '@bsh/degent-market-sdk';
import { DomainError, StaleWriteError } from './domain/errors.js';
import { INSCRIPTION_ID_RE } from './domain/validation.js';
import type { Clock } from './ports/clock.js';
import type { Logger } from './application/logger.js';
import { silentLogger } from './application/logger.js';
import type { MarketService } from './application/market-service.js';

export interface AppOptions {
  market: MarketService;
  clock: Clock;
  /** Exact origins allowed for browser calls. Empty = deny all cross-origin browser calls. */
  corsOrigins: string[];
  rateLimit?: { windowMs: number; max: number };
  clientIp?: (c: Context) => string;
  trustProxy?: boolean;
  log?: Logger;
}

/** A buy PSBT with 20 payment inputs is ~10 KB hex; leave room, refuse anything bigger. */
export const JSON_BODY_LIMIT = 512 * 1024;

function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

function rateLimiter(opts: { windowMs: number; max: number }, clock: Clock, ipOf: (c: Context) => string): MiddlewareHandler {
  const hits = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const now = clock.now().getTime();
    const ip = ipOf(c);
    let h = hits.get(ip);
    if (!h || now - h.start >= opts.windowMs) {
      h = { start: now, count: 0 };
      hits.set(ip, h);
      if (hits.size > 50_000) for (const [k, v] of hits) if (now - v.start >= opts.windowMs) hits.delete(k);
    }
    h.count++;
    if (h.count > opts.max) {
      c.header('retry-after', String(Math.ceil((h.start + opts.windowMs - now) / 1000)));
      return c.json(errorBody('rate_limited', 'too many requests; slow down'), 429);
    }
    return next();
  };
}

function defaultIp(trustProxy: boolean) {
  return (c: Context): string => {
    if (trustProxy) {
      const xff = c.req.header('x-forwarded-for');
      if (xff) return xff.split(',')[0]!.trim();
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? 'unknown';
  };
}

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  const log = o.log ?? silentLogger;
  const m = o.market;
  const allowed = new Set(o.corsOrigins);

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  });
  app.use(
    '*',
    cors({
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type'],
      maxAge: 600,
    }),
  );
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin) && c.req.method !== 'GET' && c.req.method !== 'OPTIONS')
      return c.json(errorBody('forbidden_origin', 'origin not allowed'), 403);
    return next();
  });
  app.use('*', rateLimiter(o.rateLimit ?? { windowMs: 60_000, max: 60 }, o.clock, o.clientIp ?? defaultIp(o.trustProxy ?? false)));
  app.use('*', bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: (c) => c.json(errorBody('payload_too_large', `request body exceeds ${JSON_BODY_LIMIT} bytes`), 413) }));

  // Kill switch: every buy route answers 503 before parsing anything while BUYS_ENABLED=false.
  app.use('/v1/buy/*', async (c, next) => {
    if (!m.settings.buysEnabled)
      return c.json(errorBody('buys_paused', 'Buying is paused until the settlement engine is verified on signet and externally reviewed.'), 503);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json(errorBody(err.code, err.message, err.details), err.status as 400);
    if (err instanceof StaleWriteError) return c.json(errorBody('conflict', 'listing changed concurrently; fetch it and retry'), 409);
    log.error('unhandled error', { path: c.req.path, error: err instanceof Error ? err.message : String(err) });
    return c.json(errorBody('internal', 'internal error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', 'no such endpoint'), 404));

  const readJson = async (c: Context): Promise<unknown> => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
      throw new DomainError('unsupported_media_type', 415, 'content-type must be application/json');
    try {
      return await c.req.json();
    } catch {
      throw new DomainError('bad_request', 400, 'body is not valid JSON');
    }
  };
  const inscriptionParam = (c: Context): string => {
    const id = c.req.param('id') ?? '';
    if (!INSCRIPTION_ID_RE.test(id)) throw new DomainError('not_found', 404, 'listing not found');
    return id;
  };

  app.get('/v1/health', async (c) => c.json(await m.health()));
  app.get('/v1/config', (c) => c.json(m.config()));
  app.get('/v1/fees', async (c) => c.json(await m.fees()));
  app.get('/v1/listings', async (c) => c.json(await m.listings()));
  app.post('/v1/listings', async (c) => c.json(await m.createListing(await readJson(c)), 201));
  app.post('/v1/listings/prepare', async (c) => c.json(await m.prepareListing(await readJson(c))));
  app.get('/v1/listings/:id', async (c) => c.json(await m.listing(inscriptionParam(c))));
  app.post('/v1/listings/:id/cancel', async (c) => {
    const id = inscriptionParam(c);
    return c.json(await m.cancelListing(id, await readJson(c)));
  });
  app.post('/v1/auth/challenge', async (c) => c.json(await m.challenge(await readJson(c))));
  app.post('/v1/buy/prepare', async (c) => c.json(await m.buyPrepare(await readJson(c))));
  app.post('/v1/buy/submit', async (c) => c.json(await m.buySubmit(await readJson(c))));

  return app;
}
