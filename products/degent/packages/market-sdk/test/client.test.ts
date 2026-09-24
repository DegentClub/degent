import { describe, expect, it } from 'vitest';
import { ApiError, createMarketClient } from '../src/index.js';

type Call = { url: string; init?: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fake(responder: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return {
    calls,
    f: async (url: string, init?: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return responder(c);
    },
  };
}

describe('createMarketClient', () => {
  it('maps every method to its endpoint and verb', async () => {
    const { f, calls } = fake(() => json(200, { ok: true }));
    const c = createMarketClient({ baseUrl: 'https://market.example/', fetch: f });
    const id = `${'a'.repeat(64)}i0`;
    await c.health();
    await c.config();
    await c.fees();
    await c.listings();
    await c.listing(id);
    await c.challenge({ action: 'list', address: 'bc1p', inscriptionId: id, priceSats: 1000 });
    await c.prepareListing({ inscriptionId: id, sellerAddress: 'bc1p', sellerPublicKey: '02', priceSats: 1000 });
    await c.createListing({ inscriptionId: id, sellerAddress: 'bc1p', sellerPublicKey: '02', priceSats: 1000, signedPsbt: 'ab', message: 'm', signature: 's' });
    await c.cancelListing(id, { sellerAddress: 'bc1p', message: 'm', signature: 's' });
    await c.buyPrepare({ inscriptionId: id, buyerAddress: 'bc1p', buyerPublicKey: '02' });
    await c.buySubmit({ sessionId: 'x', signedPsbt: 'ab' });
    expect(calls.map((x) => `${x.init?.method} ${x.url.replace('https://market.example', '')}`)).toEqual([
      'GET /v1/health',
      'GET /v1/config',
      'GET /v1/fees',
      'GET /v1/listings',
      `GET /v1/listings/${id}`,
      'POST /v1/auth/challenge',
      'POST /v1/listings/prepare',
      'POST /v1/listings',
      `POST /v1/listings/${id}/cancel`,
      'POST /v1/buy/prepare',
      'POST /v1/buy/submit',
    ]);
    const post = calls[5]!;
    expect((post.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(post.init?.body))).toEqual({ action: 'list', address: 'bc1p', inscriptionId: id, priceSats: 1000 });
  });

  it('surfaces structured errors as ApiError (e.g. buys paused)', async () => {
    const { f } = fake(() => json(503, { error: { code: 'buys_paused', message: 'paused' } }));
    const c = createMarketClient({ baseUrl: 'https://m', fetch: f });
    const err = await c.buyPrepare({ inscriptionId: 'x', buyerAddress: 'y', buyerPublicKey: 'z' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'buys_paused' });
  });

  it('maps non-JSON failures, network errors and empty bodies', async () => {
    const c1 = createMarketClient({ baseUrl: 'https://m', fetch: async () => new Response('nope', { status: 502 }) });
    await expect(c1.health()).rejects.toMatchObject({ status: 502, code: 'http_error' });
    const c2 = createMarketClient({ baseUrl: 'https://m', fetch: async () => { throw new Error('offline'); } });
    await expect(c2.health()).rejects.toMatchObject({ status: 0, code: 'network_error' });
    const c3 = createMarketClient({ baseUrl: 'https://m', fetch: async () => new Response('', { status: 200 }) });
    await expect(c3.health()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
