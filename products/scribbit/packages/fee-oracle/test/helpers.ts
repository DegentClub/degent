import type { FeeSource, FetchLike, SourceReading } from '../src/index.js';

export type Route = (url: string, init?: RequestInit) => unknown | Response | Promise<unknown | Response>;

/** Fake fetch: routes by exact URL (or prefix match with '*'), records every call. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(init === undefined ? { url } : { url, init });
    const key = Object.keys(routes).find((k) => (k.endsWith('*') ? url.startsWith(k.slice(0, -1)) : k === url));
    if (!key) return new Response('not found', { status: 404 });
    const out = await routes[key]!(url, init);
    return out instanceof Response ? out : Response.json(out);
  };
  return { fetch, calls };
}

/** A controllable in-memory source. */
export function scriptedSource(id: string, reading: SourceReading | (() => SourceReading | Promise<SourceReading>)) {
  let current = reading;
  let fail: string | null = null;
  let calls = 0;
  const source: FeeSource = {
    id,
    kind: 'static',
    async fetch() {
      calls++;
      if (fail) throw new Error(fail);
      return typeof current === 'function' ? current() : structuredClone(current);
    },
  };
  return {
    source,
    set(r: SourceReading) {
      current = r;
    },
    fail(msg: string | null) {
      fail = msg;
    },
    get calls() {
      return calls;
    },
  };
}

export const flat = (r: number): SourceReading => ({ targets: { 1: r, 3: r, 6: r, 144: r } });

/** Deterministic PRNG for property-style tests. */
export function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}
