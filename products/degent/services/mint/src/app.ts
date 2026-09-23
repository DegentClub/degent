/**
 * HTTP API (contracts/openapi/degent-mint.yaml). Thin: parses/limits requests, calls the
 * OrderService, maps domain errors to structured JSON errors. No secrets in any response.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { ApiErrorBody, FeesResponse, HealthResponse, ServiceConfig } from '@bsh/degent-mint-sdk';
import type { ApprovalService } from './application/approval-service.js';
import type { OrderService } from './application/order-service.js';
import type { RegisterService } from './application/register-service.js';
import type { Logger } from './application/logger.js';
import { silentLogger } from './application/logger.js';
import { DomainError, StaleWriteError } from './domain/errors.js';
import { IllegalTransitionError } from './domain/state-machine.js';
import type { ChainPort } from './ports/chain.js';
import type { FeePort } from './ports/fees.js';
import type { ParentUtxoProvider } from './ports/parent-utxo.js';
import type { Clock } from './ports/clock.js';

export interface AppOptions {
  orders: OrderService;
  approval: ApprovalService;
  register: RegisterService;
  fees: FeePort;
  chain?: ChainPort;
  parents?: ParentUtxoProvider;
  clock: Clock;
  /** Exact origins allowed for browser calls. Empty = deny all cross-origin browser calls. */
  corsOrigins: string[];
  rateLimit?: { windowMs: number; max: number };
  /** Client IP for rate limiting. Default: first X-Forwarded-For hop when trustProxy, else socket. */
  clientIp?: (c: Context) => string;
  trustProxy?: boolean;
  log?: Logger;
}

export const JSON_BODY_LIMIT = 16 * 1024;
/** A half-signed reveal PSBT carries the full leaf script (content up to 3.9 MB) in base64. */
export const REVEAL_BODY_LIMIT = 8 * 1024 * 1024;

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Fixed-window per-IP limiter for mutating requests. In-process: run one API replica per limiter scope. */
function rateLimiter(opts: { windowMs: number; max: number }, clock: Clock, ipOf: (c: Context) => string): MiddlewareHandler {
  const hits = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    if (c.req.method !== 'POST' && c.req.method !== 'PUT') return next();
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
  const s = o.orders.settings;
  const allowed = new Set(o.corsOrigins);

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
  });

  // CORS: default deny. A browser request from an origin not on the allowlist gets no CORS
  // headers (so the browser blocks the response) and mutating requests are refused outright.
  app.use(
    '*',
    cors({
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowHeaders: ['content-type', 'authorization'],
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

  const tooLarge = (limit: number) => (c: Context) =>
    c.json(errorBody('payload_too_large', `request body exceeds ${limit} bytes`), 413);

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json(errorBody(err.code, err.message, err.details), err.status as 400);
    if (err instanceof IllegalTransitionError || err instanceof StaleWriteError)
      return c.json(errorBody('conflict', 'order changed concurrently; fetch it and retry'), 409);
    log.error('unhandled error', { path: c.req.path, error: err instanceof Error ? err.message : String(err) });
    return c.json(errorBody('internal', 'internal error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', 'no such endpoint'), 404));

  const orderId = (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (!ORDER_ID.test(id)) throw new DomainError('not_found', 404, 'order not found');
    return id;
  };
  const readJson = async (c: Context) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
      throw new DomainError('unsupported_media_type', 415, 'content-type must be application/json');
    try {
      return await c.req.json();
    } catch {
      throw new DomainError('bad_request', 400, 'body is not valid JSON');
    }
  };

  app.get('/v1/health', async (c) => {
    const checks: HealthResponse['checks'] = {};
    try {
      await o.orders.queueSnapshot();
      checks.store = { ok: true };
    } catch (e) {
      checks.store = { ok: false, detail: 'store unavailable' };
    }
    if (o.chain) {
      try {
        checks.chain = { ok: true, detail: `tip ${await o.chain.getTipHeight()}` };
      } catch {
        checks.chain = { ok: false, detail: 'chain backend unreachable' };
      }
    }
    if (o.parents) {
      const p = await o.parents.current().catch(() => null);
      checks.parent = p ? { ok: true, detail: p.confirmed ? 'confirmed' : 'unconfirmed' } : { ok: false, detail: 'no parent UTXO' };
    }
    const ok = Object.values(checks).every((x) => x.ok);
    const body: HealthResponse = {
      status: ok ? 'ok' : 'degraded',
      network: s.network,
      version: s.version,
      time: o.clock.now().toISOString(),
      checks,
    };
    return c.json(body, 200);
  });

  app.get('/v1/config', (c) => {
    const body: ServiceConfig = {
      ...s.collection,
      network: s.network,
      collectionAddress: s.collectionAddress,
      serviceFeeAddress: s.serviceFeeAddress,
      maxUploadBytes: s.maxUploadBytes,
    };
    return c.json(body);
  });

  app.get('/v1/fees', async (c) => {
    let fees;
    try {
      fees = await o.fees.getFees();
    } catch {
      return c.json(errorBody('upstream_unavailable', 'fee estimates temporarily unavailable'), 503);
    }
    const min = s.collection.minFeeRate;
    const clamp = (x: number) => Math.max(min, x);
    const body: FeesResponse = {
      network: s.network,
      minFeeRate: min,
      standard: { slow: clamp(fees.standard.slow), normal: clamp(fees.standard.normal), fast: clamp(fees.standard.fast) },
      block: { min: clamp(fees.block.min), recommended: clamp(fees.block.recommended) },
      fetchedAt: fees.fetchedAt,
    };
    return c.json(body);
  });

  app.get('/v1/queue', async (c) => c.json(await o.orders.queueSnapshot()));

  app.post('/v1/orders', bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge(JSON_BODY_LIMIT) }), async (c) => {
    const res = await o.orders.createOrder(await readJson(c));
    return c.json(res, 201);
  });

  app.put(
    '/v1/orders/:id/content',
    bodyLimit({ maxSize: s.maxUploadBytes, onError: tooLarge(s.maxUploadBytes) }),
    async (c) => {
      const id = orderId(c);
      const ct = (c.req.header('content-type') ?? '').toLowerCase().split(';')[0]!.trim();
      // Authorise before reading up to 4 MB of body.
      await o.orders.authorize(id, c.req.header('authorization'));
      if (ct !== 'application/octet-stream')
        throw new DomainError('unsupported_media_type', 415, 'content-type must be application/octet-stream');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(await o.orders.uploadContent(id, c.req.header('authorization'), bytes));
    },
  );

  app.post(
    '/v1/orders/:id/reveal',
    bodyLimit({ maxSize: REVEAL_BODY_LIMIT, onError: tooLarge(REVEAL_BODY_LIMIT) }),
    async (c) => {
      const id = orderId(c);
      await o.orders.authorize(id, c.req.header('authorization'));
      return c.json(await o.orders.submitReveal(id, c.req.header('authorization'), await readJson(c)));
    },
  );

  app.get('/v1/orders/:id', async (c) => c.json(await o.orders.getOrder(orderId(c))));

  app.get('/v1/orders/:id/rescue', async (c) =>
    c.json(await o.orders.getRescue(orderId(c), c.req.header('authorization'))),
  );

  // ---------------------------------------------------------------- member approval (ADR-0005)

  app.post('/v1/auth/challenge', bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge(JSON_BODY_LIMIT) }), async (c) =>
    c.json(await o.approval.challenge(await readJson(c))),
  );
  app.post('/v1/auth/verify', bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge(JSON_BODY_LIMIT) }), async (c) =>
    c.json(await o.approval.verify(await readJson(c))),
  );
  app.get('/v1/review', async (c) => {
    const session = await o.approval.authorizeHolder(c.req.header('authorization'));
    return c.json(await o.approval.reviewQueue(session));
  });
  app.get('/v1/orders/:id/votes', async (c) => c.json(await o.approval.votes(orderId(c))));
  app.post('/v1/orders/:id/votes', bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge(JSON_BODY_LIMIT) }), async (c) => {
    const id = orderId(c);
    const session = await o.approval.authorizeHolder(c.req.header('authorization'));
    return c.json(await o.approval.castVote(id, session, await readJson(c)));
  });

  // ---------------------------------------------------------------- the Register (public, read-only)

  app.get('/v1/register', async (c) => c.json(await o.register.summary()));
  app.get('/v1/register/holder/:address', async (c) => c.json(await o.register.holder(c.req.param('address'))));
  app.get('/v1/register/verify/:inscriptionId', async (c) => c.json(await o.register.verify(c.req.param('inscriptionId'))));
  app.get('/v1/register/:n', async (c) => c.json(await o.register.member(c.req.param('n'))));
  app.get('/v1/explorer', async (c) => c.json(await o.register.explorer(c.req.query())));
  app.get('/v1/stats', async (c) => c.json(await o.register.stats()));

  return app;
}
