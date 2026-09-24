/** MintHolderRegistry over the typed mint client: endpoint, cache, retries (ported from gate-holders tests). */
import { describe, expect, it } from 'vitest';
import { createMintClient } from '@bsh/degent-mint-sdk';
import { MintHolderRegistry } from '../src/adapters/mint-holder-registry.js';

type Reply = { status: number; body: unknown } | Error;

function setup(replies: Reply[], extra: { cacheTtlMs?: number; retries?: number } = {}) {
  let t = 1_000_000;
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const next = replies.shift();
    if (!next) throw new Error('no more replies');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  const sleeps: number[] = [];
  const registry = new MintHolderRegistry(createMintClient({ baseUrl: 'https://mint.example/', fetch }), {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    backoffMs: 100,
    retries: extra.retries ?? 3,
    cacheTtlMs: extra.cacheTtlMs ?? 5 * 60 * 1000,
  });
  return { registry, urls, sleeps, advance: (ms: number) => (t += ms) };
}

const holder = (address: string, degents: number[]) => ({ status: 200, body: { address, holder: degents.length > 0, degents } });
const err = (status: number, code = 'internal') => ({ status, body: { error: { code, message: code } } });

describe('MintHolderRegistry', () => {
  it('calls GET /v1/register/holder/{address} and returns the Degent numbers', async () => {
    const { registry, urls } = setup([holder('bc1qabc', [12, 340])]);
    expect(await registry.getHoldings('bc1qabc')).toEqual([12, 340]);
    expect(urls).toEqual(['https://mint.example/v1/register/holder/bc1qabc']);
  });

  it('caches for 5 minutes, bech32 case-insensitively', async () => {
    const { registry, urls, advance } = setup([holder('a', [1]), holder('a', [])]);
    await registry.getHoldings('bc1qabc');
    await registry.getHoldings('BC1QABC');
    advance(4 * 60 * 1000);
    expect(await registry.getHoldings('bc1qabc')).toEqual([1]);
    expect(urls).toHaveLength(1);
    advance(2 * 60 * 1000);
    expect(await registry.getHoldings('bc1qabc')).toEqual([]);
    expect(urls).toHaveLength(2);
  });

  it('bypasses the cache with fresh: true', async () => {
    const { registry, urls } = setup([holder('a', [1]), holder('a', [])]);
    await registry.getHoldings('a');
    expect(await registry.getHoldings('a', { fresh: true })).toEqual([]);
    expect(urls).toHaveLength(2);
  });

  it('invalidate drops a cached answer', async () => {
    const { registry, urls } = setup([holder('a', [1]), holder('a', [2])]);
    await registry.getHoldings('a');
    registry.invalidate('a');
    expect(await registry.getHoldings('a')).toEqual([2]);
    expect(urls).toHaveLength(2);
  });

  it.each([404, 422])('treats %i as "holds nothing" without retrying', async (status) => {
    const { registry, urls } = setup([err(status, 'validation_failed')]);
    expect(await registry.getHoldings('a')).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('holder:false wins over a stray degents list', async () => {
    const { registry } = setup([{ status: 200, body: { address: 'a', holder: false, degents: [5] } }]);
    expect(await registry.getHoldings('a')).toEqual([]);
  });

  it('retries 5xx, 429 and network errors with exponential backoff', async () => {
    const { registry, urls, sleeps } = setup([err(503), err(429, 'rate_limited'), new Error('ECONNRESET'), holder('a', [7])]);
    expect(await registry.getHoldings('a')).toEqual([7]);
    expect(urls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('gives up after the configured retries', async () => {
    const { registry, urls } = setup([err(500), err(500), err(500), err(500)]);
    await expect(registry.getHoldings('a')).rejects.toMatchObject({ status: 500 });
    expect(urls).toHaveLength(4);
  });

  it('does not retry other 4xx', async () => {
    const { registry, urls } = setup([err(400, 'bad_request')]);
    await expect(registry.getHoldings('a')).rejects.toMatchObject({ status: 400 });
    expect(urls).toHaveLength(1);
  });

  it('rejects a malformed body (retried, then thrown)', async () => {
    const bad = { status: 200, body: { nope: true } };
    const { registry } = setup([bad, bad], { retries: 1 });
    await expect(registry.getHoldings('a')).rejects.toThrow(/degents/);
  });

  it('drops non-integer and non-positive entries', async () => {
    const { registry } = setup([{ status: 200, body: { address: 'a', holder: true, degents: [1, '2', null, 3.5, 0, -4, 4] } }]);
    expect(await registry.getHoldings('a')).toEqual([1, 4]);
  });
});
