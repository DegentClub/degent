import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MeterClient,
  MeterContractError,
  MeterHttpError,
  MeterNetworkError,
  MeterTimeoutError,
  schemas,
  validate,
  type MeterClientOptions,
} from '../src/index.js';

/**
 * Fixtures were written by hand from the type definitions (the live API is not reachable from CI);
 * they include every documented field, so they also exercise the optional-field type checks.
 */
const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function client(handler: Handler, extra: MeterClientOptions = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const c = new MeterClient({
    baseUrl: 'https://meter.test/',
    fetch: async (u, init) => {
      calls.push(u);
      return handler(new URL(u), init);
    },
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      signal?.throwIfAborted();
    },
    random: () => 0.5,
    ...extra,
  });
  return { c, calls, sleeps };
}

const routes: Record<string, string> = {
  '/api/tokens': 'tokens',
  '/api/token/rune/840000%3A3': 'token-detail',
  '/api/protocols': 'protocols',
  '/api/block/840000': 'block-840000',
  '/api/growth': 'growth',
  '/api/meter': 'meter',
  '/api/frontier': 'frontier',
  '/api/summary': 'summary',
  '/api/landmarks': 'landmarks',
};
const fixtureServer: Handler = (u) => {
  const name = routes[u.pathname];
  return name ? json(fx(name)) : json({ error: 'not found' }, 404);
};

describe('endpoints parse recorded fixtures', () => {
  it('every endpoint returns its typed body', async () => {
    const { c, calls } = client(fixtureServer);
    const tokens = await c.tokens({ book: 'a', denom: 'bytes', limit: 2, offset: 0, q: '' });
    expect(tokens.rows[0]!.ref).toBe('ordi');
    expect(tokens.total).toBe(184233);
    expect(calls[0]).toBe('https://meter.test/api/tokens?book=a&denom=bytes&limit=2&offset=0');

    const token = await c.token('rune', '840000:3');
    expect(token.a_bytes).toBe(4412000000);
    expect('rn' in token).toBe(false);

    expect((await c.protocols('a', 'bytes')).rows).toHaveLength(2);
    expect((await c.block(840000)).ledger.block_hash).toMatch(/^0{19}/);
    const g = await c.growth(100000);
    expect(g.series.at(-1)!.cum_a_bytes).toBe(3000);
    expect((await c.meter()).chain_tip.height).toBe(915012);
    expect((await c.frontier()).cursors).toHaveLength(2);
    expect((await c.summary()).books?.a?.complete).toBe(true);
    expect((await c.landmarks()).rows[2]!.height).toBe(840000);
    expect(calls).toContain('https://meter.test/api/growth?bucket=100000');
  });

  it('accepts additive fields (not drift) and absent optional fields', async () => {
    const meter = { chain_tip: { height: 1 }, brand_new_field: { x: 1 } };
    const { c } = client(() => json(meter));
    expect((await c.meter()).chain_tip.height).toBe(1);
  });

  it('validates arguments before touching the network', async () => {
    const { c, calls } = client(fixtureServer);
    expect(() => c.block(-1)).toThrow(RangeError);
    expect(() => c.block(1.5)).toThrow(RangeError);
    expect(() => c.growth(0)).toThrow(RangeError);
    expect(() => c.tokens({ limit: 0 })).toThrow(RangeError);
    expect(() => c.token('', 'x')).toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe('contract drift fails loudly', () => {
  it('missing required field', async () => {
    const body = fx('block-840000') as { ledger: Record<string, unknown> };
    delete body.ledger.block_hash;
    const { c, calls } = client(() => json(body));
    const err = await c.block(840000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeterContractError);
    expect((err as MeterContractError).issues).toEqual([{ path: '$.ledger.block_hash', expected: 'string', got: 'undefined' }]);
    expect(calls).toHaveLength(1); // never retried
  });

  it('wrong type in a nested array element, and in an optional field that is present', async () => {
    const body = fx('tokens') as { rows: Record<string, unknown>[] };
    body.rows[1]!.attributed = '4412000000';
    body.rows[0]!.coverage = 7;
    const { c } = client(() => json(body));
    const err = (await c.tokens().catch((e: unknown) => e)) as MeterContractError;
    expect(err.issues.map((i) => i.path)).toEqual(['$.rows[0].coverage', '$.rows[1].attributed']);
    expect(err.message).toContain('$.rows[1].attributed expected number, got string "4412000000"');
  });

  it('unknown enum value (a new book) is drift', async () => {
    const body = fx('protocols') as Record<string, unknown>;
    body.book = 'd';
    const { c } = client(() => json(body));
    await expect(c.protocols()).rejects.toBeInstanceOf(MeterContractError);
  });

  it('non-JSON 200 (e.g. an HTML error page) is drift', async () => {
    const { c } = client(() => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const err = (await c.meter().catch((e: unknown) => e)) as MeterContractError;
    expect(err).toBeInstanceOf(MeterContractError);
    expect(err.issues[0]).toMatchObject({ path: '$', expected: 'object' });
  });

  it('every fixture passes its schema (fixtures and schemas agree)', () => {
    const pairs: [unknown, string][] = [
      [schemas.tokensResponse, 'tokens'],
      [schemas.tokenDetailRow, 'token-detail'],
      [schemas.protocolsResponse, 'protocols'],
      [schemas.blockDetail, 'block-840000'],
      [schemas.growthResponse, 'growth'],
      [schemas.meterResponse, 'meter'],
      [schemas.frontierResponse, 'frontier'],
      [schemas.summaryResponse, 'summary'],
      [schemas.landmarksResponse, 'landmarks'],
    ];
    for (const [g, name] of pairs) expect(validate(g as typeof schemas.meterResponse, fx(name)), name).toEqual([]);
  });
});

describe('retries and backoff', () => {
  it('retries 503 then succeeds, with exponential jittered backoff', async () => {
    let n = 0;
    const onRetry = vi.fn();
    const { c, calls, sleeps } = client(
      () => (++n < 3 ? json({ error: 'database unavailable' }, 503) : json(fx('meter'))),
      { retries: 3, backoff: { baseMs: 100, maxMs: 10_000 }, onRetry },
    );
    expect((await c.meter()).chain_tip.height).toBe(915012);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([50, 100]); // random 0.5 * (100, 200)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, reason: 'database unavailable' }));
  });

  it('gives up after retries and surfaces the last HTTP error with its body', async () => {
    const { c, calls } = client(() => json({ error: 'statement timeout' }, 500), { retries: 2 });
    const err = (await c.summary().catch((e: unknown) => e)) as MeterHttpError;
    expect(err).toBeInstanceOf(MeterHttpError);
    expect(err.status).toBe(500);
    expect(err.attempts).toBe(3);
    expect(err.body).toEqual({ error: 'statement timeout' });
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx', async () => {
    const { c, calls } = client(() => json({ error: 'unknown token' }, 404));
    await expect(c.token('rune', 'nope')).rejects.toMatchObject({ status: 404, message: 'unknown token' });
    expect(calls).toHaveLength(1);
  });

  it('honours Retry-After on 429, capped at maxMs', async () => {
    let n = 0;
    const { c, sleeps } = client(() => (n++ === 0 ? json({}, 429, { 'retry-after': '2' }) : json(fx('frontier'))), {
      backoff: { baseMs: 100, maxMs: 1500 },
    });
    await c.frontier();
    expect(sleeps).toEqual([1500]);
  });

  it('retries network errors and wraps the final one', async () => {
    const { c, calls } = client(() => {
      throw new TypeError('fetch failed');
    });
    const err = await c.meter().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeterNetworkError);
    expect((err as MeterNetworkError).message).toContain('fetch failed');
    expect(calls).toHaveLength(3);
  });
});

describe('timeouts and abort', () => {
  /** A fetch that never answers until its signal aborts. */
  const hang: Handler = (_u, init) =>
    new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));

  it('times out each attempt and reports MeterTimeoutError', async () => {
    const { c, calls } = client(hang, { timeoutMs: 20, retries: 1 });
    const err = (await c.meter().catch((e: unknown) => e)) as MeterTimeoutError;
    expect(err).toBeInstanceOf(MeterTimeoutError);
    expect(err.timeoutMs).toBe(20);
    expect(calls).toHaveLength(2);
  });

  it('a caller abort is rethrown as-is and never retried', async () => {
    const ctl = new AbortController();
    const { c, calls } = client(hang, { timeoutMs: 10_000, retries: 5 });
    const p = c.meter({ signal: ctl.signal });
    const reason = new Error('user navigated away');
    setTimeout(() => ctl.abort(reason), 5);
    await expect(p).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('an already-aborted signal makes no request', async () => {
    const { c, calls } = client(fixtureServer);
    await expect(c.meter({ signal: AbortSignal.abort() })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('abort during backoff stops the retry loop', async () => {
    const ctl = new AbortController();
    const { c, calls } = client(() => json({}, 503), {
      retries: 5,
      sleep: async (_ms, signal) => {
        ctl.abort(new Error('stop'));
        signal?.throwIfAborted();
      },
    });
    await expect(c.meter({ signal: ctl.signal })).rejects.toThrow('stop');
    expect(calls).toHaveLength(1);
  });
});
