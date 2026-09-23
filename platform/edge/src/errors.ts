import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorBody } from './context.js';

/** Throw from handlers to produce a specific `{error:{code,message}}`. */
export class EdgeError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(status, { message });
    this.name = 'EdgeError';
  }
}

const CODES: Record<number, [string, string]> = {
  400: ['bad_request', 'Bad request'],
  401: ['unauthorized', 'Unauthorized'],
  403: ['forbidden', 'Forbidden'],
  404: ['not_found', 'Not found'],
  405: ['method_not_allowed', 'Method not allowed'],
  406: ['not_acceptable', 'Not acceptable'],
  408: ['request_timeout', 'Request timeout'],
  409: ['conflict', 'Conflict'],
  410: ['gone', 'Gone'],
  413: ['payload_too_large', 'Payload too large'],
  415: ['unsupported_media_type', 'Unsupported media type'],
  422: ['unprocessable_entity', 'Unprocessable entity'],
  429: ['rate_limited', 'Too many requests'],
  500: ['internal_error', 'Internal server error'],
  502: ['bad_gateway', 'Bad gateway'],
  503: ['unavailable', 'Service unavailable'],
  504: ['gateway_timeout', 'Gateway timeout'],
};

export function statusCode(status: number): [string, string] {
  return CODES[status] ?? (status >= 500 ? ['internal_error', 'Internal server error'] : ['error', 'Request failed']);
}

export interface JsonErrorsOptions {
  /** Called for every unexpected (non-HTTP) error, e.g. to log with the request id. */
  onUnexpected?: (err: Error, c: Context) => void;
}

function render(err: Error, c: Context, opts: JsonErrorsOptions): Response {
  if (err instanceof EdgeError) return c.json(errorBody(c, err.code, err.message), err.status, err.headers);
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    const [code, fallback] = statusCode(status);
    // 5xx messages are never exposed; 4xx HTTPException messages are author-controlled.
    const message = status >= 500 ? fallback : err.message || fallback;
    const headers: Record<string, string> = {};
    const wa = err.res?.headers.get('WWW-Authenticate');
    if (wa) headers['WWW-Authenticate'] = wa;
    return c.json(errorBody(c, code, message), status, headers);
  }
  opts.onUnexpected?.(err, c);
  // Never leak internal error messages / stacks.
  return c.json(errorBody(c, 'internal_error', 'Internal server error'), 500);
}

/** `app.onError(jsonErrorHandler())`: uniform JSON for thrown errors, no stack traces, no console noise. */
export function jsonErrorHandler(opts: JsonErrorsOptions = {}): ErrorHandler {
  return (err, c) => render(err, c, opts);
}

/** `app.notFound(jsonNotFound())`. */
export function jsonNotFound(): NotFoundHandler {
  return (c) => c.json(errorBody(c, 'not_found', 'Not found'), 404);
}

/**
 * Middleware that guarantees every error leaves as `{error:{code,message,requestId}}`:
 * thrown errors (via `c.error`) and any non-JSON 4xx/5xx response (Hono's default 404, a framework
 * 405, a proxied text error). Headers such as Retry-After / WWW-Authenticate are preserved.
 * Install right after `requestId()`. Also set `app.onError(jsonErrorHandler())` to silence Hono's
 * default console logging of thrown errors.
 */
export function jsonErrors(opts: JsonErrorsOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    let replacement: Response;
    if (c.error) {
      replacement = render(c.error, c, opts);
    } else {
      const status = c.res.status;
      if (status < 400) return;
      const ct = c.res.headers.get('Content-Type') ?? '';
      if (/^application\/(problem\+)?json/i.test(ct)) return;
      const [code, message] = statusCode(status);
      replacement = c.json(errorBody(c, code, message), status as ContentfulStatusCode);
    }
    // Keep headers other middleware already put on the response (CORS, request id, Retry-After, ...),
    // but never the old body's representation headers.
    const headers = new Headers(c.res.headers);
    for (const h of ['content-type', 'content-length', 'content-encoding', 'content-range', 'etag', 'last-modified'])
      headers.delete(h);
    for (const [k, v] of replacement.headers) headers.set(k, v);
    c.res = undefined as unknown as Response;
    c.res = new Response(replacement.body, { status: replacement.status, headers });
  };
}
