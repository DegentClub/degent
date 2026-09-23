/**
 * Minimal local edge middleware. `@bsh/edge` (platform/edge) was still being written when this
 * service landed (no public entry point yet), so the handful of behaviours we need live here, kept
 * in one file so switching to `@bsh/edge` is a local change:
 *
 * - request id (`x-request-id`, echoed or generated)
 * - security headers
 * - uniform JSON errors `{ error: { code, message, details? } }`
 * - constant-time bearer-token check for admin routes
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'collection_not_found'
  | 'not_certified'
  | 'refresh_in_progress'
  | 'manifest_invalid'
  | 'manifest_not_found'
  | 'parent_not_found'
  | 'upstream_error'
  | 'internal';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 422 | 502,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    c.set('requestId' as never, id as never);
    await next();
    c.header('x-request-id', id);
  };
}

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
  };
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** `Authorization: Bearer <token>`; compares sha256 digests in constant time. */
export function bearerAuth(token: string): MiddlewareHandler {
  if (token.length < 16) throw new Error('admin token must be at least 16 characters');
  const want = digest(token);
  return async (c: Context, next) => {
    const h = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m || !timingSafeEqual(digest(m[1]!.trim()), want)) {
      c.header('www-authenticate', 'Bearer');
      return c.json(errorBody('unauthorized', 'missing or invalid admin token'), 401);
    }
    return next();
  };
}
