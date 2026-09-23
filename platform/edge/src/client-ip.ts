import type { Context, MiddlewareHandler } from 'hono';
import { cidrContains, formatIp, parseCidr, parseIp, type Cidr } from './ip.js';

/** Returns the TCP peer address. Default understands @hono/node-server (`c.env.incoming`) and Bun/Deno-style `c.env.remoteAddr`. */
export type RemoteAddressFn = (c: Context) => string | undefined;

export const defaultRemoteAddress: RemoteAddressFn = (c) => {
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } }; remoteAddr?: { hostname?: string } | string }
    | undefined;
  const fromNode = env?.incoming?.socket?.remoteAddress;
  if (fromNode) return fromNode;
  const ra = env?.remoteAddr;
  return typeof ra === 'string' ? ra : ra?.hostname;
};

export interface TrustProxyOptions {
  /**
   * Number of reverse proxies we operate in front of the app (each appends to X-Forwarded-For).
   * The client is the entry `hops` positions from the right of [...XFF, peer].
   */
  hops?: number;
  /** Proxy addresses / CIDRs we trust. XFF is only read when the TCP peer is one of them. */
  trusted?: readonly string[];
  header?: string;
  getRemoteAddress?: RemoteAddressFn;
}

export const UNKNOWN_IP = 'unknown';

function canon(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const p = parseIp(ip);
  return p ? formatIp(p) : undefined;
}

/**
 * Resolve the client IP for a request. Forwarding headers are IGNORED unless `trustProxy()` was
 * configured (it stores its answer in `c.get('clientIp')`); otherwise the TCP peer is used.
 */
export function getClientIp(c: Context, getRemoteAddress: RemoteAddressFn = defaultRemoteAddress): string {
  return c.get('clientIp') ?? canon(getRemoteAddress(c)) ?? UNKNOWN_IP;
}

/**
 * Opt-in X-Forwarded-For handling. Without this middleware, XFF is never consulted (a client can
 * put anything in it). Configure exactly one of `hops` or `trusted`.
 */
export function trustProxy(opts: TrustProxyOptions): MiddlewareHandler {
  const header = opts.header ?? 'X-Forwarded-For';
  const remote = opts.getRemoteAddress ?? defaultRemoteAddress;
  if ((opts.hops === undefined) === (opts.trusted === undefined)) throw new Error('trustProxy: set exactly one of hops or trusted');
  if (opts.hops !== undefined && (!Number.isInteger(opts.hops) || opts.hops < 1 || opts.hops > 10))
    throw new Error('trustProxy: hops must be 1..10');
  const trusted: Cidr[] = (opts.trusted ?? []).map(parseCidr);
  const isTrusted = (ip: string): boolean => {
    const p = parseIp(ip);
    return !!p && trusted.some((t) => cidrContains(t, p));
  };

  return async (c, next) => {
    const peer = canon(remote(c));
    const raw = c.req.raw.headers.get(header) ?? '';
    const xff = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const chain = [...xff, peer ?? UNKNOWN_IP];
    let client: string | undefined;
    if (opts.hops !== undefined) {
      const idx = Math.max(0, chain.length - 1 - opts.hops);
      // Entries right of idx were appended by our proxies; if a hop is garbage, fall back to the nearest valid hop.
      for (let i = idx; i < chain.length && client === undefined; i++) client = canon(chain[i]);
    } else if (peer && isTrusted(peer)) {
      for (let i = chain.length - 2; i >= 0; i--) {
        const hop = canon(chain[i]);
        if (!hop) break; // unparseable: stop at the last trusted proxy we could read
        client = hop;
        if (!isTrusted(hop)) break;
      }
      client ??= peer;
    } else {
      client = peer;
    }
    c.set('clientIp', client ?? UNKNOWN_IP);
    await next();
  };
}
