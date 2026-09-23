import type { MiddlewareHandler } from 'hono';
import { appendVary, errorResponse, setResponseHeader } from './context.js';

export interface CorsOptions {
  /** Send Access-Control-Allow-Credentials: true (cookies / Authorization). Default false. */
  credentials?: boolean;
  allowMethods?: readonly string[];
  allowHeaders?: readonly string[];
  exposeHeaders?: readonly string[];
  /** Preflight cache in seconds. Default 600. */
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const DEFAULT_HEADERS = ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'];
const DEFAULT_EXPOSE = ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'];

function normaliseOrigin(o: string): string {
  if (o === '*') return o;
  let url: URL;
  try {
    url = new URL(o);
  } catch {
    throw new Error(`corsAllowlist: invalid origin ${JSON.stringify(o)}`);
  }
  if (url.origin === 'null' || url.origin !== o || o.includes('*'))
    throw new Error(`corsAllowlist: origin must be exactly scheme://host[:port] (got ${JSON.stringify(o)}, expected ${url.origin})`);
  return o;
}

/**
 * Default-deny CORS. Only origins in the allowlist (exact, case-sensitive string match on the
 * serialised origin) receive CORS headers; everyone else gets none (and a 403 on preflight).
 * `*` is only allowed without credentials. `Origin: null` is never allowed.
 */
export function corsAllowlist(origins: readonly string[], opts: CorsOptions = {}): MiddlewareHandler {
  const list = origins.map(normaliseOrigin);
  const wildcard = list.includes('*');
  if (wildcard && opts.credentials) throw new Error('corsAllowlist: "*" cannot be combined with credentials');
  const allowed = new Set(list.filter((o) => o !== '*'));
  const methods = (opts.allowMethods ?? DEFAULT_METHODS).join(', ');
  const allowHeaders = (opts.allowHeaders ?? DEFAULT_HEADERS).join(', ');
  const expose = (opts.exposeHeaders ?? DEFAULT_EXPOSE).join(', ');
  const maxAge = String(opts.maxAge ?? 600);

  const allowOriginFor = (origin: string | undefined): string | undefined => {
    if (!origin || origin === 'null') return undefined;
    if (allowed.has(origin)) return origin;
    return wildcard ? '*' : undefined;
  };

  return async (c, next) => {
    const origin = c.req.header('Origin');
    const acao = allowOriginFor(origin);
    const isPreflight = c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Method') !== undefined;

    if (isPreflight) {
      if (!acao) {
        const res = errorResponse(c, 403, 'cors_origin_denied', 'Origin not allowed');
        res.headers.set('Vary', 'Origin');
        return res;
      }
      const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': acao,
        'Access-Control-Allow-Methods': methods,
        'Access-Control-Allow-Headers': allowHeaders,
        'Access-Control-Max-Age': maxAge,
        Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      };
      if (opts.credentials) headers['Access-Control-Allow-Credentials'] = 'true';
      return c.body(null, 204, headers);
    }

    await next();
    if (!wildcard || allowed.size > 0) appendVary(c, 'Origin');
    if (!acao) return;
    setResponseHeader(c, 'Access-Control-Allow-Origin', acao);
    if (opts.credentials) setResponseHeader(c, 'Access-Control-Allow-Credentials', 'true');
    if (expose) setResponseHeader(c, 'Access-Control-Expose-Headers', expose);
  };
}
