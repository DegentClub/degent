import type { MiddlewareHandler } from 'hono';
import { setResponseHeader } from './context.js';

export type HeaderValue = string | false;

export interface SecurityHeadersOptions {
  /** API default: nothing may be loaded or framed. Override for HTML-serving apps. */
  contentSecurityPolicy?: HeaderValue;
  strictTransportSecurity?: HeaderValue;
  referrerPolicy?: HeaderValue;
  frameOptions?: HeaderValue;
  crossOriginOpenerPolicy?: HeaderValue;
  crossOriginResourcePolicy?: HeaderValue;
  permissionsPolicy?: HeaderValue;
  /** Cache-Control applied only when the handler did not set one. API default `no-store`. */
  cacheControl?: HeaderValue;
}

const DEFAULTS: Required<SecurityHeadersOptions> = {
  contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  strictTransportSecurity: 'max-age=63072000; includeSubDomains',
  referrerPolicy: 'no-referrer',
  frameOptions: 'DENY',
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-site',
  permissionsPolicy: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  cacheControl: 'no-store',
};

/**
 * Hardened response headers for JSON APIs. Every header can be overridden or disabled with
 * `false`. Always sets `X-Content-Type-Options: nosniff` and strips `X-Powered-By` / `Server`.
 */
export function securityHeaders(opts: SecurityHeadersOptions = {}): MiddlewareHandler {
  const o = { ...DEFAULTS, ...opts };
  const pairs: [string, HeaderValue][] = [
    ['Content-Security-Policy', o.contentSecurityPolicy],
    ['Strict-Transport-Security', o.strictTransportSecurity],
    ['Referrer-Policy', o.referrerPolicy],
    ['X-Frame-Options', o.frameOptions],
    ['Cross-Origin-Opener-Policy', o.crossOriginOpenerPolicy],
    ['Cross-Origin-Resource-Policy', o.crossOriginResourcePolicy],
    ['Permissions-Policy', o.permissionsPolicy],
    ['X-Content-Type-Options', 'nosniff'],
  ];
  return async (c, next) => {
    await next();
    for (const [name, value] of pairs) if (value !== false) setResponseHeader(c, name, value);
    if (o.cacheControl !== false && !c.res.headers.has('Cache-Control')) setResponseHeader(c, 'Cache-Control', o.cacheControl);
    for (const h of ['X-Powered-By', 'Server']) {
      if (c.res.headers.has(h)) {
        try {
          c.res.headers.delete(h);
        } catch {
          const res = new Response(c.res.body, c.res);
          res.headers.delete(h);
          c.res = res;
        }
      }
    }
  };
}
