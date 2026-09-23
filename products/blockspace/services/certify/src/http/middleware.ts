/**
 * Service-local middleware. Everything generic (request ids, JSON errors, security headers, CORS,
 * rate limits, body limits) comes from `@bsh/edge`; the only thing left here is the operator
 * bearer token for `refresh`, which is a single shared secret rather than an `@bsh/edge` API key.
 */
import { createHash } from 'node:crypto';
import { EdgeError, timingSafeEqual } from '@bsh/edge';
import type { MiddlewareHandler } from 'hono';

/** Error codes this service emits (contracts/openapi/blockspace-collections.yaml `Error.code`). */
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
  | 'rate_limited'
  | 'payload_too_large'
  | 'internal_error';

/** Throw from handlers: rendered by `@bsh/edge` as `{ error: { code, message, requestId } }`. */
export function httpError(status: 400 | 401 | 404 | 409 | 422 | 502, code: ErrorCode, message: string, headers?: Record<string, string>): EdgeError {
  return new EdgeError(status, code, message, headers);
}

const hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** `Authorization: Bearer <token>`; compares sha256 digests in constant time (length is fixed). */
export function adminBearer(token: string): MiddlewareHandler {
  if (token.length < 16) throw new Error('admin token must be at least 16 characters');
  const want = hex(token);
  return async (c, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m || !timingSafeEqual(hex(m[1]!.trim()), want))
      throw httpError(401, 'unauthorized', 'missing or invalid admin token', { 'WWW-Authenticate': 'Bearer' });
    return next();
  };
}
