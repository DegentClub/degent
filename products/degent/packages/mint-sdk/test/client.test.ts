import { describe, expect, it } from 'vitest';
import { ApiError, createMintClient } from '../src/index.js';

type Call = { url: string; init?: RequestInit };

function fakeFetch(responder: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    return responder(c);
  };
  return { f, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createMintClient', () => {
  it('maps every method to its endpoint', async () => {
    const { f, calls } = fakeFetch(() => json(200, { ok: true }));
    const c = createMintClient({ baseUrl: 'https://mint.example/', fetch: f });
    await c.health();
    await c.config();
    await c.fees();
    await c.queue();
    await c.createOrder({
      tier: 'standard',
      contentType: 'image/png',
      contentLength: 1,
      contentSha256: 'a'.repeat(64),
      recipientAddress: 'bc1p',
      revealPubkey: 'b'.repeat(64),
      feeRate: 2,
    });
    await c.uploadContent('ord/1', 'tok', new Uint8Array([1, 2, 3]));
    await c.submitReveal('o1', 'tok', { commitTxid: 'c'.repeat(64), commitVout: 0, halfSignedRevealPsbt: 'cHNidP8=' });
    await c.getOrder('o1');
    await c.getRescue('o1', 'tok');
    await c.authChallenge({ address: 'bc1p' });
    await c.authVerify({ address: 'bc1p', message: 'm', signature: 's' });
    await c.reviewQueue('sess');
    await c.castVote('o1', 'sess', { vote: 'approve', message: 'm', signature: 's' });
    await c.getVotes('o1');
    await c.register();
    await c.registerMember(4113);
    await c.registerHolder('bc1p');
    await c.registerVerify('a'.repeat(64) + 'i0');
    await c.explorer({ offset: 20, limit: 10, sort: 'bytes', order: 'desc', q: 'bc1' });
    await c.explorer();
    await c.stats();
    await c.subscribeOrder('o1', 'tok', { channel: 'email', address: 'gent@example.com' });
    expect(calls.map((x) => `${x.init?.method} ${x.url}`)).toEqual([
      'GET https://mint.example/v1/health',
      'GET https://mint.example/v1/config',
      'GET https://mint.example/v1/fees',
      'GET https://mint.example/v1/queue',
      'POST https://mint.example/v1/orders',
      'PUT https://mint.example/v1/orders/ord%2F1/content',
      'POST https://mint.example/v1/orders/o1/reveal',
      'GET https://mint.example/v1/orders/o1',
      'GET https://mint.example/v1/orders/o1/rescue',
      'POST https://mint.example/v1/auth/challenge',
      'POST https://mint.example/v1/auth/verify',
      'GET https://mint.example/v1/review',
      'POST https://mint.example/v1/orders/o1/votes',
      'GET https://mint.example/v1/orders/o1/votes',
      'GET https://mint.example/v1/register',
      'GET https://mint.example/v1/register/4113',
      'GET https://mint.example/v1/register/holder/bc1p',
      `GET https://mint.example/v1/register/verify/${'a'.repeat(64)}i0`,
      'GET https://mint.example/v1/explorer?offset=20&limit=10&sort=bytes&order=desc&q=bc1',
      'GET https://mint.example/v1/explorer',
      'GET https://mint.example/v1/stats',
      'POST https://mint.example/v1/orders/o1/subscriptions',
    ]);
    const auth = calls.map((x) => (x.init?.headers as Record<string, string>).authorization ?? null);
    expect(auth.slice(0, 9)).toEqual([null, null, null, null, null, 'Bearer tok', 'Bearer tok', null, 'Bearer tok']);
    expect(auth.slice(9)).toEqual([null, null, 'Bearer sess', 'Bearer sess', null, null, null, null, null, null, null, null, 'Bearer tok']);
    expect(JSON.parse(String(calls.at(-1)!.init!.body))).toEqual({ channel: 'email', address: 'gent@example.com' });
    const put = calls[5]!.init!;
    expect((put.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    expect(put.body).toEqual(new Uint8Array([1, 2, 3]));
    const post = calls[4]!.init!;
    expect((post.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(post.body as string).feeRate).toBe(2);
  });

  it('raises a typed ApiError from the structured error body', async () => {
    const { f } = fakeFetch(() => json(409, { error: { code: 'rescue_unavailable', message: 'not yet', details: { status: 'queued' } } }));
    const c = createMintClient({ baseUrl: 'http://x', fetch: f });
    const err = await c.getRescue('o1', 'tok').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'rescue_unavailable', message: 'not yet', details: { status: 'queued' } });
  });

  it('raises ApiError for non-JSON errors and network failures', async () => {
    const c1 = createMintClient({ baseUrl: 'http://x', fetch: async () => new Response('boom', { status: 502 }) });
    await expect(c1.health()).rejects.toMatchObject({ status: 502, code: 'http_error' });
    const c2 = createMintClient({
      baseUrl: 'http://x',
      fetch: async () => {
        throw new TypeError('failed to fetch');
      },
    });
    await expect(c2.health()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });
});
