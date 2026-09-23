import { describe, expect, it } from 'vitest';
import { bitcoindSource, blockLaneSource, esploraSource, mempoolBlocksSource, mempoolRecommendedSource, staticSource } from '../src/index.js';
import { fakeFetch } from './helpers.js';

const signal = new AbortController().signal;

describe('mempool.space recommended', () => {
  it('maps fastest/halfHour/hour/economy/minimum to targets 1/3/6/144 and minRelay', async () => {
    const { fetch, calls } = fakeFetch({
      'https://mempool.example/signet/api/v1/fees/recommended': () => ({ fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1 }),
    });
    const src = mempoolRecommendedSource({ baseUrl: 'https://mempool.example/signet/', fetch });
    expect(src.id).toBe('mempool:mempool.example/signet');
    expect(await src.fetch(signal)).toEqual({ targets: { 1: 12, 3: 8, 6: 5, 144: 2 }, minRelay: 1 });
    expect(calls).toHaveLength(1);
  });

  it('fails on HTTP errors and unusable bodies', async () => {
    const { fetch } = fakeFetch({
      'https://a/api/v1/fees/recommended': () => new Response('busy', { status: 503 }),
      'https://b/api/v1/fees/recommended': () => ({ fastestFee: 'x' }),
      'https://c/api/v1/fees/recommended': () => new Response('<html>', { status: 200 }),
    });
    await expect(mempoolRecommendedSource({ baseUrl: 'https://a', fetch }).fetch(signal)).rejects.toThrow('HTTP 503');
    await expect(mempoolRecommendedSource({ baseUrl: 'https://b', fetch }).fetch(signal)).rejects.toThrow('no usable');
    await expect(mempoolRecommendedSource({ baseUrl: 'https://c', fetch }).fetch(signal)).rejects.toThrow('invalid JSON');
  });
});

describe('mempool.space projected blocks', () => {
  const block = (medianFee: number, feeRange: number[], blockVSize = 997_000, totalFees = Math.round(medianFee * 1.3 * blockVSize)) => ({
    blockSize: 1_600_000,
    blockVSize,
    nTx: 3000,
    totalFees,
    medianFee,
    feeRange,
  });

  it('uses projected block medians per target and the block-1 displacement rate for the block lane', async () => {
    const blocks = [
      block(10, [8, 9, 10, 40], 997_000, 12_961_000),
      block(7, [6, 7, 8]),
      block(5, [4, 5, 6]),
      block(4, [3, 4]),
      block(3, [2.5, 3]),
      block(2.5, [2, 2.5]),
      block(2, [1.5, 2]),
      block(1.5, [1.01, 1.5], 3_500_000),
    ];
    const { fetch } = fakeFetch({ 'https://m/api/v1/fees/mempool-blocks': () => blocks });
    const reading = await mempoolBlocksSource({ baseUrl: 'https://m', fetch }).fetch(signal);
    expect(reading.targets).toEqual({ 1: 10, 3: 5, 6: 2.5, 144: 1.01 });
    expect(reading.block).toEqual({ recommended: 13 }); // 12,961,000 sat / 997,000 vB
  });

  it('reports no block-lane recommendation for a part-full next block, and nothing for an empty mempool', async () => {
    const { fetch } = fakeFetch({
      'https://p/api/v1/fees/mempool-blocks': () => [block(2, [1, 3], 120_000)],
      'https://e/api/v1/fees/mempool-blocks': () => [],
    });
    const part = await mempoolBlocksSource({ baseUrl: 'https://p', fetch }).fetch(signal);
    expect(part.block).toBeUndefined();
    expect(part.targets).toEqual({ 1: 2, 3: 2, 6: 2, 144: 1 });
    expect(await mempoolBlocksSource({ baseUrl: 'https://e', fetch }).fetch(signal)).toEqual({ targets: {} });
  });
});

describe('esplora', () => {
  it('reads exact keys and falls back to the nearest shorter target', async () => {
    const { fetch } = fakeFetch({
      'https://e/api/fee-estimates': () => ({ '1': 20.5, '2': 15, '4': 9, '25': 3, '144': 1.2, '1008': 1 }),
    });
    const reading = await esploraSource({ baseUrl: 'https://e/api', fetch }).fetch(signal);
    expect(reading).toEqual({ targets: { 1: 20.5, 3: 15, 6: 9, 144: 1.2 } });
  });

  it('uses the nearest longer target when nothing shorter exists', async () => {
    const { fetch } = fakeFetch({ 'https://e/fee-estimates': () => ({ '6': 4 }) });
    expect(await esploraSource({ baseUrl: 'https://e', fetch }).fetch(signal)).toEqual({ targets: { 1: 4, 3: 4, 6: 4, 144: 4 } });
  });

  it('rejects empty estimates', async () => {
    const { fetch } = fakeFetch({ 'https://e/fee-estimates': () => ({}) });
    await expect(esploraSource({ baseUrl: 'https://e', fetch }).fetch(signal)).rejects.toThrow('no usable');
  });
});

type RpcBody = { method: string; params: unknown[] };
const rpc = (handler: (b: RpcBody) => unknown) => (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as RpcBody;
  const out = handler(body);
  if (out instanceof Response) return out;
  return { result: out, error: null, id: 'x' };
};

describe('bitcoind estimatesmartfee', () => {
  it('converts BTC/kvB to sat/vB, sends basic auth, omits targets without data', async () => {
    const { fetch, calls } = fakeFetch({
      'http://node:8332/': rpc((b) => {
        if (b.method === 'getmempoolinfo') return { mempoolminfee: 0.00001, minrelaytxfee: 0.00001 };
        const t = b.params[0];
        if (t === 144) return { errors: ['Insufficient data or no feerate found'], blocks: 0 };
        return { feerate: t === 1 ? 0.0002 : t === 3 ? 0.00012345 : 0.00005, blocks: t };
      }),
    });
    const src = bitcoindSource({ url: 'http://rpcuser:s3cret@node:8332', fetch });
    expect(src.id).toBe('bitcoind:node:8332');
    const reading = await src.fetch(signal);
    expect(reading).toEqual({ targets: { 1: 20, 3: 12.345, 6: 5 }, minRelay: 1 });
    expect(calls).toHaveLength(5);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa('rpcuser:s3cret')}`);
    expect(calls[0]!.url).toBe('http://node:8332/'); // credentials never in the URL sent
    expect(JSON.parse(String(calls[1]!.init!.body)).params).toEqual([1, 'CONSERVATIVE']);
  });

  it('surfaces RPC errors (HTTP 500 with an error body)', async () => {
    const { fetch } = fakeFetch({
      'http://node/': () => Response.json({ result: null, error: { code: -32601, message: 'Method not found' } }, { status: 500 }),
    });
    await expect(bitcoindSource({ url: 'http://node', auth: { user: 'u', password: 'p' }, fetch }).fetch(signal)).rejects.toThrow(
      'Method not found',
    );
  });

  it('fails when the estimator and mempool report nothing', async () => {
    const { fetch } = fakeFetch({ 'http://node/': rpc((b) => (b.method === 'getmempoolinfo' ? {} : { errors: ['no data'] })) });
    await expect(bitcoindSource({ url: 'http://node', fetch }).fetch(signal)).rejects.toThrow('no data');
  });
});

describe('Libre Relay block lane', () => {
  it('reports the node floor as block.min and estimatesmartfee as block.recommended', async () => {
    const { fetch } = fakeFetch({
      'http://libre:8332/': rpc((b) =>
        b.method === 'getmempoolinfo' ? { mempoolminfee: 0.000001, minrelaytxfee: 0.000001 } : { feerate: 0.00004, blocks: 2 },
      ),
    });
    const src = blockLaneSource({ url: 'http://libre:8332', fetch });
    expect(src.kind).toBe('block-lane');
    expect(await src.fetch(signal)).toEqual({ block: { min: 0.1, recommended: 4 } });
  });

  it('keeps the floor when the estimator fails', async () => {
    const { fetch } = fakeFetch({
      'http://libre/': rpc((b) =>
        b.method === 'getmempoolinfo' ? { mempoolminfee: 0.000002 } : Response.json({ error: { message: 'boom' } }, { status: 500 }),
      ),
    });
    expect(await blockLaneSource({ url: 'http://libre', fetch }).fetch(signal)).toEqual({ block: { min: 0.2 } });
  });
});

describe('static', () => {
  it('returns a defensive copy', async () => {
    const src = staticSource({ targets: { 1: 2 } }, 'regtest');
    const a = await src.fetch(signal);
    a.targets![1] = 99;
    expect(await src.fetch(signal)).toEqual({ targets: { 1: 2 } });
  });
});
