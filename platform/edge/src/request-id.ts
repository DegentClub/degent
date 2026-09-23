import type { MiddlewareHandler } from 'hono';
import { setResponseHeader } from './context.js';

export interface RequestIdOptions {
  /** Header read (if trusted) and always written. Default `X-Request-Id`. */
  header?: string;
  /**
   * Reuse a well-formed incoming id (set by our own load balancer / gateway). Default false: a public
   * client must not be able to choose ids that end up in our logs.
   */
  trustIncoming?: boolean;
  generator?: () => string;
}

const ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Assign every request an id: `c.get('requestId')`, echoed in the response header and in JSON errors. */
export function requestId(opts: RequestIdOptions = {}): MiddlewareHandler {
  const header = opts.header ?? 'X-Request-Id';
  const gen = opts.generator ?? (() => crypto.randomUUID());
  return async (c, next) => {
    const incoming = opts.trustIncoming ? c.req.header(header) : undefined;
    const id = incoming && ID_RE.test(incoming) ? incoming : gen();
    c.set('requestId', id);
    c.header(header, id);
    await next();
    setResponseHeader(c, header, id);
  };
}
