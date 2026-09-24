/**
 * HTTP API (contracts/openapi/degent-atelier.yaml). Thin: @bsh/edge middleware, bearer session auth,
 * request parsing, AtelierService calls, structured errors. Never returns provider errors verbatim
 * and never logs tokens or keys.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit, corsAllowlist, getClientIp, jsonErrorHandler, jsonErrors, jsonNotFound, rateLimit, requestId, securityHeaders, trustProxy } from '@bsh/edge';
import type { AtelierService, Job } from './application/atelier-service.js';
import { isId } from './application/atelier-service.js';
import type { Logger } from './application/logger.js';
import { silentLogger } from './application/logger.js';
import { AtelierError } from './domain/errors.js';
import { MAX_UPLOAD_BYTES, MAX_VARIATIONS, PLACARDS, TIERS } from './domain/tiers.js';
import type { SessionRecord } from './adapters/state-store.js';
import { isSha256Hex } from './adapters/content-store.js';

export interface AppOptions {
  service: AtelierService;
  corsOrigins: string[];
  /** CIDRs of proxies we run; X-Forwarded-For is only honoured behind them. */
  trustedProxies?: string[];
  rateLimitPerMinute?: number;
  sessionRateLimitPerMinute?: number;
  /** Absolute base for previewUrl / downloadUrl; empty = relative paths. */
  publicBaseUrl?: string;
  now?: () => number;
  log?: Logger;
}

export const JSON_BODY_LIMIT = 16 * 1024;

/** Hono wants an ArrayBuffer-backed view; copy only if the bytes sit on a SharedArrayBuffer. */
const asBody = (b: Uint8Array): Uint8Array<ArrayBuffer> => (b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : new Uint8Array(b));

declare module 'hono' {
  interface ContextVariableMap {
    session: SessionRecord;
  }
}

function errorJson(c: Context, e: AtelierError): Response {
  const body = { error: { code: e.code, message: e.message, requestId: c.get('requestId') ?? null, ...(e.details === undefined ? {} : { details: e.details }) } };
  return c.json(body, e.status);
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const ct = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw new AtelierError(415, 'unsupported_media_type', 'send application/json');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AtelierError(400, 'validation_failed', 'body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AtelierError(422, 'validation_failed', 'body must be a JSON object');
  return body as Record<string, unknown>;
}

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  const log = o.log ?? silentLogger;
  const svc = o.service;
  const base = (o.publicBaseUrl ?? '').replace(/\/$/, '');
  const url = (path: string) => `${base}${path}`;
  const now = o.now ?? Date.now;

  const edgeOnError = jsonErrorHandler({ onUnexpected: (err, c) => log.error('unhandled error', { path: c.req.path, requestId: c.get('requestId'), error: err.message }) });
  // Domain errors carry `details`, which the edge renderer drops. Hono records a caught error on
  // `c.error` and jsonErrors() would re-render it, so clear it once we have rendered it ourselves.
  app.onError((err, c) => {
    if (err instanceof AtelierError) {
      c.error = undefined;
      return errorJson(c, err);
    }
    return edgeOnError(err, c);
  });
  app.notFound(jsonNotFound());
  app.use(requestId());
  app.use(jsonErrors({ onUnexpected: (err, c) => log.error('unhandled error', { path: c.req.path, requestId: c.get('requestId'), error: err.message }) }));
  app.use(securityHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use(
    corsAllowlist(o.corsOrigins, {
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'Content-Length', 'ETag'],
    }),
  );
  if (o.trustedProxies?.length) app.use(trustProxy({ trusted: o.trustedProxies }));
  app.use(rateLimit({ windowMs: 60_000, max: o.rateLimitPerMinute ?? 120, prefix: 'ip', now }));

  // Bearer session auth + per-session rate limit for everything that costs money or CPU.
  const authed: MiddlewareHandler = async (c, next) => {
    const h = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    const session = await svc.authenticate(m?.[1]);
    if (!session) throw new AtelierError(401, 'unauthorized', 'a valid session token is required (POST /v1/sessions)');
    c.set('session', session);
    await next();
  };
  const perSession = rateLimit({ windowMs: 60_000, max: o.sessionRateLimitPerMinute ?? 30, prefix: 'session', key: (c) => c.get('session')?.id, now });

  const jobView = (j: Job) => ({
    id: j.id,
    status: j.status,
    tier: j.tier,
    placard: j.placard,
    brief: j.brief,
    variations: j.variations,
    provider: j.provider,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    candidates: svc.candidatesOf(j).map((cand) => ({
      id: cand.id,
      previewUrl: url(`/v1/candidates/${cand.id}/preview`),
      width: cand.width,
      height: cand.height,
      providerRef: cand.providerRef,
      review: cand.review,
    })),
  });

  app.get('/v1/health', async (c) => c.json(await svc.health()));

  app.get('/v1/config', (c) =>
    c.json({
      tiers: TIERS.map((t) => ({ tier: t.tier, label: t.label, minBytes: t.minBytes, maxBytes: t.maxBytes })),
      placards: [...PLACARDS],
      maxVariations: MAX_VARIATIONS,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      sessionDailyImages: svc.deps.quotas.sessionDailyImages,
    }),
  );

  app.post('/v1/sessions', bodyLimit(JSON_BODY_LIMIT), async (c) => {
    const { session, token, quota } = await svc.createSession(getClientIp(c));
    return c.json({ sessionId: session.id, token, expiresAt: session.expiresAt, quota }, 201);
  });

  app.post('/v1/generate', bodyLimit(JSON_BODY_LIMIT), authed, perSession, async (c) => {
    const body = await readJson(c);
    const job = await svc.createJob(c.get('session'), {
      brief: body.brief,
      palette: body.palette,
      mood: body.mood,
      placard: body.placard,
      tier: body.tier,
      variations: body.variations,
      seed: body.seed,
    });
    return c.json({ jobId: job.id, status: job.status, statusUrl: url(`/v1/jobs/${job.id}`), quota: await svc.quota(job.sessionId) }, 202);
  });

  app.get('/v1/jobs/:id', authed, async (c) => {
    const id = c.req.param('id');
    const job = isId(id) ? svc.getJob(c.get('session'), id) : null;
    if (!job) throw new AtelierError(404, 'not_found', 'job not found');
    return c.json(jobView(job));
  });

  app.post('/v1/candidates/:id/finalize', bodyLimit(JSON_BODY_LIMIT), authed, perSession, async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) throw new AtelierError(404, 'not_found', 'candidate not found');
    const body = await readJson(c);
    const r = await svc.finalize(c.get('session'), id, { tier: body.tier, placard: body.placard });
    return c.json({ ...r, downloadUrl: url(`/v1/content/${r.contentSha256}`) });
  });

  // Preview bytes are unguessable-id addressed and safe to embed in <img>; no bearer needed.
  app.get('/v1/candidates/:id/preview', async (c) => {
    const id = c.req.param('id');
    const cand = isId(id) ? svc.getCandidate(id) : null;
    const bytes = cand ? await svc.content(cand.previewSha256) : null;
    if (!cand || !bytes) throw new AtelierError(404, 'not_found', 'candidate not found');
    return c.body(asBody(bytes), 200, { 'content-type': 'image/jpeg', 'content-length': String(bytes.length), 'cache-control': 'private, max-age=3600', etag: `"${cand.previewSha256}"` });
  });

  app.post('/v1/upload', bodyLimit(MAX_UPLOAD_BYTES), authed, perSession, async (c) => {
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    let bytes: Uint8Array;
    let fields: Record<string, unknown>;
    if (ct.startsWith('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new AtelierError(422, 'validation_failed', 'multipart body needs a "file" part');
      bytes = new Uint8Array(await file.arrayBuffer());
      fields = { frame: form.frame, tier: form.tier, placard: form.placard };
    } else if (ct.startsWith('application/octet-stream') || ct.startsWith('image/')) {
      bytes = new Uint8Array(await c.req.arrayBuffer());
      const q = c.req.query();
      fields = { frame: q.frame, tier: q.tier, placard: q.placard };
    } else throw new AtelierError(415, 'unsupported_media_type', 'send the image as application/octet-stream (query: tier, placard, frame) or multipart/form-data (file, tier, placard, frame)');
    if (bytes.length === 0) throw new AtelierError(422, 'validation_failed', 'empty upload');
    const frameRaw = fields.frame;
    const frame = frameRaw === undefined || frameRaw === '' ? true : frameRaw === true || frameRaw === 'true' || frameRaw === '1';
    if (!(frameRaw === undefined || frameRaw === '' || frameRaw === true || frameRaw === false || frameRaw === 'true' || frameRaw === 'false' || frameRaw === '1' || frameRaw === '0'))
      throw new AtelierError(422, 'validation_failed', 'frame must be true or false');
    const r = await svc.upload(c.get('session'), bytes, { frame, tier: fields.tier, placard: fields.placard === '' ? undefined : fields.placard });
    return c.json({ ...r, downloadUrl: url(`/v1/content/${r.contentSha256}`) });
  });

  // Exact bytes, content addressed. The mint front end fetches these and PUTs them unchanged.
  app.get('/v1/content/:sha256', async (c) => {
    const sha = c.req.param('sha256');
    const bytes = isSha256Hex(sha) ? await svc.content(sha) : null;
    if (!bytes) throw new AtelierError(404, 'not_found', 'content not found');
    return c.body(asBody(bytes), 200, {
      'content-type': 'image/jpeg',
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${sha}"`,
      'content-disposition': `attachment; filename="degent-${sha.slice(0, 12)}.jpg"`,
    });
  });

  return app;
}
