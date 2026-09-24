/**
 * HTTP API (contracts/openapi/degent-telegram-gate.yaml). Thin: CORS (the web origin only), body limit,
 * per-IP rate limit on POST, JSON parsing, GateError -> `{ error: { code, message } }`. The invite link is
 * never part of any response: it only travels by Telegram DM.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { GateService } from './application/gate-service.js';
import { silentLogger, type Logger } from './application/logger.js';
import { GateError } from './domain/errors.js';

export interface AppOptions {
  service: GateService;
  /** Exact origins allowed for browser calls (the site serving /verify). */
  corsOrigins: string[];
  rateLimit?: { windowMs: number; max: number };
  trustProxy?: boolean;
  clientIp?: (c: Context) => string;
  now?: () => number;
  log?: Logger;
}

export const JSON_BODY_LIMIT = 16 * 1024;

const errorBody = (code: string, message: string) => ({ error: { code, message } });

function rateLimiter(opts: { windowMs: number; max: number }, now: () => number, ipOf: (c: Context) => string): MiddlewareHandler {
  const hits = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const t = now();
    const ip = ipOf(c);
    let h = hits.get(ip);
    if (!h || t - h.start >= opts.windowMs) {
      h = { start: t, count: 0 };
      hits.set(ip, h);
      if (hits.size > 50_000) for (const [k, v] of hits) if (t - v.start >= opts.windowMs) hits.delete(k);
    }
    h.count++;
    if (h.count > opts.max) {
      c.header('retry-after', String(Math.ceil((h.start + opts.windowMs - t) / 1000)));
      return c.json(errorBody('rate_limited', 'too many requests; slow down'), 429);
    }
    return next();
  };
}

/**
 * Rate-limit key. Behind the proxy (trustProxy) the left-most X-Forwarded-For entry is whatever the client
 * sent, so it is never used: the proxy's own view comes from X-Client-IP (the deploy's Caddy site sets it from
 * {client_ip}, overwriting anything the client sent), or failing that from the right-most XFF entry (appended
 * by the nearest proxy). Without trustProxy: the socket address.
 */
export function clientIpOf(trustProxy: boolean) {
  const IP = /^[0-9A-Fa-f.:]{2,45}$/;
  return (c: Context): string => {
    if (trustProxy) {
      const direct = c.req.header('x-client-ip')?.trim();
      if (direct && IP.test(direct)) return direct;
      const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last && IP.test(last)) return last;
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? 'unknown';
  };
}

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  const log = o.log ?? silentLogger;
  const now = o.now ?? Date.now;
  const allowed = new Set(o.corsOrigins);

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
  });
  app.use(
    '*',
    cors({
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'authorization'],
      maxAge: 600,
    }),
  );
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin) && c.req.method === 'POST') return c.json(errorBody('forbidden_origin', 'origin not allowed'), 403);
    return next();
  });
  app.use('*', rateLimiter(o.rateLimit ?? { windowMs: 60_000, max: 30 }, now, o.clientIp ?? clientIpOf(o.trustProxy ?? false)));
  app.use('*', bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: (c) => c.json(errorBody('payload_too_large', `request body exceeds ${JSON_BODY_LIMIT} bytes`), 413) }));

  app.onError((err, c) => {
    if (err instanceof GateError) return c.json(errorBody(err.code, err.message), err.status as 400);
    log.error('gate: unhandled error', { path: c.req.path, error: err instanceof Error ? err.message : String(err) });
    return c.json(errorBody('internal', 'internal error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', 'no such endpoint'), 404));

  const readJson = async (c: Context): Promise<unknown> => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
      throw new GateError('unsupported_media_type', 415, 'content-type must be application/json');
    try {
      return await c.req.json();
    } catch {
      throw new GateError('bad_request', 400, 'body is not valid JSON');
    }
  };

  app.get('/gate/health', (c) => c.json({ status: 'ok' }));
  app.post('/gate/challenge', async (c) => c.json(await o.service.challenge(await readJson(c))));
  app.post('/gate/verify', async (c) => c.json(await o.service.verify(await readJson(c))));
  app.post('/gate/admin/challenge', async (c) => c.json(await o.service.adminChallenge(await readJson(c))));
  app.post('/gate/admin/verify', async (c) => c.json(await o.service.adminVerify(await readJson(c))));
  app.get('/gate/stats', async (c) => {
    o.service.authorizeAdmin(c.req.header('authorization'));
    return c.json(await o.service.stats());
  });

  return app;
}
