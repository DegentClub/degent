import { describe, expect, it } from 'vitest';
import { createFeeOracle, FeesUnavailableError, type FeeSource } from '../src/index.js';
import { flat, scriptedSource } from './helpers.js';

function clock(start = Date.parse('2026-09-23T12:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createFeeOracle', () => {
  it('validates its inputs', () => {
    expect(() => createFeeOracle({ network: 'mainnet', sources: [] })).toThrow('at least one source');
    const a = scriptedSource('a', flat(1));
    expect(() => createFeeOracle({ network: 'mainnet', sources: [a.source, a.source] })).toThrow('duplicate');
    expect(() => createFeeOracle({ network: 'mainnet', sources: [a.source], config: { minRelayFeeRate: 0 } })).toThrow('minRelayFeeRate');
  });

  it('caches for the TTL, then refreshes', async () => {
    const c = clock();
    const a = scriptedSource('a', flat(5));
    const oracle = createFeeOracle({ network: 'signet', sources: [a.source], ttlMs: 30_000, now: c.now });
    const first = await oracle.getFees();
    expect(first).toMatchObject({ network: 'signet', standard: { slow: 5, normal: 5, fast: 5 }, stale: false, sources: ['a'] });
    expect(first.fetchedAt).toBe('2026-09-23T12:00:00.000Z');
    c.advance(29_000);
    a.set(flat(8));
    expect((await oracle.getFees()).standard.fast).toBe(5);
    expect(a.calls).toBe(1);
    c.advance(1_000);
    expect((await oracle.getFees()).standard.fast).toBe(8);
    expect(a.calls).toBe(2);
    expect((await oracle.getFees({ force: true })).standard.fast).toBe(8);
    expect(a.calls).toBe(3);
  });

  it('shares one in-flight fan-out between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = scriptedSource('a', async () => {
      await gate;
      return flat(3);
    });
    const oracle = createFeeOracle({ network: 'mainnet', sources: [a.source] });
    const all = Promise.all([oracle.getFees(), oracle.getFees(), oracle.getFees()]);
    release();
    const res = await all;
    expect(a.calls).toBe(1);
    expect(new Set(res.map((r) => r.standard.fast))).toEqual(new Set([3]));
  });

  it('aggregates across healthy sources and survives a failing one (degraded health)', async () => {
    const c = clock();
    const a = scriptedSource('a', flat(4));
    const b = scriptedSource('b', flat(6));
    const d = scriptedSource('down', flat(100));
    d.fail('ECONNREFUSED');
    const oracle = createFeeOracle({ network: 'mainnet', sources: [a.source, b.source, d.source], now: c.now });
    const fees = await oracle.getFees();
    expect(fees.standard.fast).toBe(5);
    expect(fees.sources).toEqual(['a', 'b']);
    const h = oracle.health();
    expect(h.status).toBe('degraded');
    const down = h.sources.find((s) => s.id === 'down')!;
    expect(down).toMatchObject({ ok: false, stale: true, lastError: 'ECONNREFUSED', consecutiveFailures: 1, lastSuccessAt: null });
    expect(h.sources.find((s) => s.id === 'a')).toMatchObject({ ok: true, stale: false, lastReading: flat(4), outliers: [] });
  });

  it('reports outliers per source in health', async () => {
    const srcs = [scriptedSource('a', flat(5)), scriptedSource('b', flat(5.5)), scriptedSource('c', flat(4.5)), scriptedSource('x', flat(60))];
    const oracle = createFeeOracle({ network: 'mainnet', sources: srcs.map((s) => s.source) });
    const fees = await oracle.getFees();
    expect(fees.standard.fast).toBe(5);
    expect(fees.sources).toEqual(['a', 'b', 'c']);
    expect(oracle.health().sources.find((s) => s.id === 'x')!.outliers).toEqual(['target:1', 'target:3', 'target:6', 'target:144']);
    expect(oracle.health().status).toBe('ok'); // an outlier is healthy, just ignored
  });

  it('serves the last aggregate flagged stale while every source fails, up to maxStale', async () => {
    const c = clock();
    const a = scriptedSource('a', flat(7));
    const oracle = createFeeOracle({ network: 'mainnet', sources: [a.source], ttlMs: 30_000, maxStaleMs: 60_000, staleAfterMs: 45_000, now: c.now });
    await oracle.getFees();
    a.fail('HTTP 502');
    c.advance(31_000);
    const stale = await oracle.getFees();
    expect(stale).toMatchObject({ stale: true, standard: { fast: 7 }, fetchedAt: '2026-09-23T12:00:00.000Z' });
    expect(oracle.health().status).toBe('down');
    expect(oracle.health().sources[0]).toMatchObject({ ok: false, stale: false, consecutiveFailures: 1 });
    c.advance(20_000);
    expect(oracle.health().sources[0]!.stale).toBe(true);
    c.advance(40_000); // 91 s after the last good aggregate > ttl + maxStale
    const err = await oracle.getFees().catch((e) => e);
    expect(err).toBeInstanceOf(FeesUnavailableError);
    expect(err.details.sources).toEqual([{ id: 'a', error: 'HTTP 502' }]);
    a.fail(null);
    expect((await oracle.getFees()).stale).toBe(false);
  });

  it('throws FeesUnavailableError when nothing ever succeeded, or only block-lane data exists', async () => {
    const a = scriptedSource('a', flat(1));
    a.fail('down');
    await expect(createFeeOracle({ network: 'mainnet', sources: [a.source] }).getFees()).rejects.toBeInstanceOf(FeesUnavailableError);
    const lr = scriptedSource('lr', { block: { min: 0.1 } });
    const err = await createFeeOracle({ network: 'mainnet', sources: [lr.source] }).getFees().catch((e) => e);
    expect(err.details.sources).toEqual([{ id: 'lr', error: 'no standard fee targets' }]);
  });

  it('times out a hanging source and aborts its signal', async () => {
    let aborted = false;
    const hang: FeeSource = {
      id: 'hang',
      kind: 'static',
      fetch: (signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => (aborted = true));
        }),
    };
    const ok = scriptedSource('ok', flat(2));
    const oracle = createFeeOracle({ network: 'mainnet', sources: [hang, ok.source], timeoutMs: 20 });
    const fees = await oracle.getFees();
    expect(fees.sources).toEqual(['ok']);
    expect(aborted).toBe(true);
    expect(oracle.health().sources[0]!.lastError).toBe('timed out after 20 ms');
  });
});
