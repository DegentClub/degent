/**
 * Optional HTTP server (Hono) exposing contracts/openapi/scribbit-fees.yaml. Import from
 * `@bsh/scribbit-fee-oracle/server`; the library entry point never loads Hono.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { FeesUnavailableError, type FeeOracle } from './oracle.js';
import { isNetwork, type ApiErrorBody, type Network } from './types.js';

export interface FeeServerOptions {
  /** One oracle per served network. The first is the default when `?network=` is omitted. */
  oracles: FeeOracle[];
  /** `Cache-Control: max-age` for GET /v1/fees. Default 10 s. */
  cacheMaxAgeSeconds?: number;
  /** Allowed CORS origins ('*' or a list). Default '*': the data is public and read-only. */
  corsOrigins?: '*' | string[];
  version?: string;
}

const error = (code: ApiErrorBody['error']['code'], message: string, details?: unknown): ApiErrorBody => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

export function createFeeServer(opts: FeeServerOptions): Hono {
  if (opts.oracles.length === 0) throw new Error('fee server needs at least one oracle');
  const byNetwork = new Map<Network, FeeOracle>();
  for (const o of opts.oracles) {
    if (byNetwork.has(o.network)) throw new Error(`two oracles for ${o.network}`);
    byNetwork.set(o.network, o);
  }
  const defaultNetwork = opts.oracles[0]!.network;
  const maxAge = opts.cacheMaxAgeSeconds ?? 10;

  const app = new Hono();
  app.use('*', cors({ origin: opts.corsOrigins ?? '*', allowMethods: ['GET', 'OPTIONS'] }));

  type Resolved = { oracle: FeeOracle } | { status: 400 | 404; body: ApiErrorBody };
  const resolve = (q: string | undefined): Resolved => {
    const network = q ?? defaultNetwork;
    if (!isNetwork(network)) return { status: 400, body: error('bad_request', `unknown network "${network}"`) };
    const oracle = byNetwork.get(network);
    if (!oracle) return { status: 404, body: error('not_found', `network "${network}" is not served here`, { served: [...byNetwork.keys()] }) };
    return { oracle };
  };

  app.get('/healthz', (c) => c.json({ status: 'ok', networks: [...byNetwork.keys()], version: opts.version ?? '0.1.0' }));

  app.get('/v1/fees', async (c) => {
    const r = resolve(c.req.query('network'));
    if (!('oracle' in r)) return c.json(r.body, r.status);
    try {
      const fees = await r.oracle.getFees();
      c.header('cache-control', fees.stale ? 'no-store' : `public, max-age=${maxAge}`);
      return c.json(fees);
    } catch (e) {
      if (e instanceof FeesUnavailableError) {
        c.header('retry-after', '5');
        return c.json(error('fees_unavailable', e.message, e.details), 503);
      }
      throw e;
    }
  });

  app.get('/v1/fees/sources', async (c) => {
    const r = resolve(c.req.query('network'));
    if (!('oracle' in r)) return c.json(r.body, r.status);
    // Poll (at most once per TTL, shared with /v1/fees) so the report reflects the current state.
    await r.oracle.getFees().catch(() => undefined);
    c.header('cache-control', 'no-store');
    return c.json(r.oracle.health());
  });

  app.notFound((c) => c.json(error('not_found', `no route for ${c.req.method} ${c.req.path}`), 404));
  app.onError((_e, c) => c.json(error('internal', 'internal error'), 500));
  return app;
}
