/**
 * The HTTP adapters for the studio and the ledger against an injected fetch (headers, paths, bodies, error
 * classification), the in-memory fakes, and the edition store on both order stores.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MetaEditionStore } from '../src/adapters/edition-store.js';
import { HttpLedgerClient, MemoryLedgerClient } from '../src/adapters/ledger-client.js';
import { MemoryOrderStore } from '../src/adapters/memory-order-store.js';
import { SqliteOrderStore } from '../src/adapters/sqlite-order-store.js';
import { HttpStudioClient, MemoryStudioClient } from '../src/adapters/studio-client.js';
import { isRbfSignalled } from '../src/adapters/esplora-chain.js';
import { LedgerClientError } from '../src/ports/ledger-client.js';
import { StudioClientError } from '../src/ports/studio-client.js';
import { EditionsSoldOutError } from '../src/ports/edition-store.js';
import { regtestAddress } from './fakes/harness.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>, calls: Call[] = []) {
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ error: { code: 'not_found', message: key } }), { status: 404, headers: { 'content-type': 'application/json' } });
    return r(init);
  };
  return { fetch, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ARTIST = regtestAddress(31);
const PAYOUT = regtestAddress(61);

describe('HttpStudioClient', () => {
  const artwork = { id: 'art_1', artist: ARTIST, title: 'One', contentType: 'image/png', contentLength: 3, contentSha256: 'ab'.repeat(32), status: 'approved', needsHuman: false };

  it('getArtwork reads the artwork and the internal payout route with the API key', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/artworks/art_1': () => json(artwork),
      [`GET /v1/internal/artists/${ARTIST}/payout`]: () => json({ address: ARTIST, payoutAddress: PAYOUT, payoutVerifiedAt: '2026-09-24T12:00:00.000Z' }),
    });
    const c = new HttpStudioClient({ studioUrl: 'http://studio.test/', apiKey: 'bsh_test_key', fetch });
    const a = await c.getArtwork('art_1');
    expect(a).toEqual({ id: 'art_1', artist: ARTIST, payoutAddress: PAYOUT, title: 'One', contentType: 'image/png', contentLength: 3, contentSha256: 'ab'.repeat(32), status: 'approved' });
    expect(calls.map((x) => x.url)).toEqual(['http://studio.test/v1/artworks/art_1', `http://studio.test/v1/internal/artists/${ARTIST}/payout`]);
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('bsh_test_key');
    expect((calls[1]!.init.headers as Record<string, string>)['x-api-key']).toBe('bsh_test_key');
  });

  it('getArtwork carries the edition facts (ADR-0012) when the studio sends them, well-formed only', async () => {
    const payout = () => json({ address: ARTIST, payoutAddress: PAYOUT, payoutVerifiedAt: null });
    const { fetch } = fakeFetch({
      'GET /v1/artworks/art_1': () => json({ ...artwork, maxEditions: 10, mintedEditions: 4, soldOut: false }),
      'GET /v1/artworks/art_2': () => json({ ...artwork, id: 'art_2', maxEditions: null, mintedEditions: 0 }),
      'GET /v1/artworks/art_3': () => json({ ...artwork, id: 'art_3', maxEditions: 0, mintedEditions: -1 }),
      [`GET /v1/internal/artists/${ARTIST}/payout`]: payout,
    });
    const c = new HttpStudioClient({ studioUrl: 'http://studio.test', apiKey: 'k', fetch });
    expect(await c.getArtwork('art_1')).toMatchObject({ maxEditions: 10, mintedEditions: 4 });
    expect(await c.getArtwork('art_2')).toMatchObject({ maxEditions: null, mintedEditions: 0 });
    const bad = (await c.getArtwork('art_3'))!;
    expect(bad).not.toHaveProperty('maxEditions');
    expect(bad).not.toHaveProperty('mintedEditions');
  });

  it('postRoyalty sends the edition when the order has one', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /v1/internal/royalties': () => json({ record: {}, created: true }, 201) });
    const c = new HttpStudioClient({ studioUrl: 'http://studio.test', apiKey: 'k', fetch });
    const rec = { orderId: 'dgt_1', artworkId: 'art_1', minterAddress: null, royaltySats: 330, fundingTxid: 'c'.repeat(64), vout: 1, at: '2026-09-24T00:00:00.000Z', edition: 7 };
    await c.postRoyalty(rec);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(rec);
  });

  it('an artist who has not proven a payout address reads as not proven; 404 artwork -> null', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/artworks/art_1': () => json(artwork),
      [`GET /v1/internal/artists/${ARTIST}/payout`]: () => json({ address: ARTIST, payoutAddress: null, payoutVerifiedAt: null }),
    });
    const c = new HttpStudioClient({ studioUrl: 'http://studio.test', apiKey: null, fetch });
    expect((await c.getArtwork('art_1'))!.payoutAddress).toBeNull();
    expect(await c.getArtwork('art_2')).toBeNull();
  });

  it('getContent returns the bytes or null; 5xx and network failures are retryable StudioClientErrors', async () => {
    const { fetch } = fakeFetch({
      'GET /v1/artworks/art_1/content': () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }),
      'GET /v1/artworks/art_5/content': () => new Response('', { status: 503 }),
    });
    const c = new HttpStudioClient({ studioUrl: 'http://studio.test', apiKey: 'k', fetch });
    expect(await c.getContent('art_1')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await c.getContent('art_9')).toBeNull();
    await expect(c.getContent('art_5')).rejects.toMatchObject({ name: 'StudioClientError', status: 503, retryable: true });
    const down = new HttpStudioClient({ studioUrl: 'http://studio.test', apiKey: 'k', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(down.getArtwork('art_1')).rejects.toMatchObject({ retryable: true, status: null });
  });

  it('postRoyalty: 201 created, 200 replay, 409 non-retryable, 503 retryable; body and headers as the contract says', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch({
      'POST /v1/internal/royalties': () => {
        n++;
        if (n === 1) return json({ record: {}, created: true }, 201);
        if (n === 2) return json({ record: {}, created: false }, 200);
        if (n === 3) return json({ error: { code: 'conflict', message: 'different facts' } }, 409);
        return json({ error: { code: 'internal', message: 'boom' } }, 503);
      },
    });
    const c = new HttpStudioClient({ studioUrl: 'http://studio.test', apiKey: 'bsh_test_key', fetch });
    const rec = { orderId: 'dgt_1', artworkId: 'art_1', minterAddress: null, royaltySats: 330, fundingTxid: 'c'.repeat(64), vout: 1, at: '2026-09-24T00:00:00.000Z' };
    expect(await c.postRoyalty(rec)).toEqual({ created: true });
    expect(await c.postRoyalty(rec)).toEqual({ created: false });
    await expect(c.postRoyalty(rec)).rejects.toMatchObject({ status: 409, retryable: false, message: expect.stringMatching(/conflict different facts/) });
    await expect(c.postRoyalty(rec)).rejects.toMatchObject({ status: 503, retryable: true });
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(rec);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('bsh_test_key');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(new StudioClientError('x', 500, true)).toBeInstanceOf(Error);
  });
});

describe('HttpLedgerClient', () => {
  it('createOrder / createPsbtPayment / observePayment: paths, product, idempotency keys, API key', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/orders': () => json({ id: 'ord_1', totalSats: 1000, status: 'created' }, 201),
      'POST /v1/orders/ord_1/payments': () => json({ id: 'pay_1', checkout: { outputs: [{ scriptHex: '00', valueSats: 1000 }] } }, 201),
      'POST /v1/payments/pay_1/observations': () => json({ payment: { status: 'paid' }, order: {}, applied: true, payouts: [{ id: 'pyo_1', payee: { kind: 'artist', ref: 'a' }, amountSats: 1, txid: 'a'.repeat(64), vout: 1, status: 'settled' }] }),
    });
    const c = new HttpLedgerClient({ ledgerUrl: 'http://ledger.test/', apiKey: 'bsh_ledger', fetch });
    const o = await c.createOrder({ customerRef: 'cust', lineItems: [{ sku: 'x', description: 'x', quantity: 1, unitSats: 1000, payee: { kind: 'club', ref: 'c', address: 'bcrt1q' } }], metadata: { a: 'b' }, idempotencyKey: 'k1' });
    expect(o).toEqual({ id: 'ord_1', totalSats: 1000 });
    const p = await c.createPsbtPayment('ord_1', { expiresAt: '2026-09-24T01:00:00.000Z', idempotencyKey: 'k2' });
    expect(p).toEqual({ id: 'pay_1', outputs: [{ scriptHex: '00', valueSats: 1000 }] });
    const obs = await c.observePayment('pay_1', { txid: 'a'.repeat(64), outputs: [{ scriptHex: '00', valueSats: 1000 }], confirmations: 1, rbfSignalled: false });
    expect(obs).toMatchObject({ applied: true, paymentStatus: 'paid', payouts: [{ id: 'pyo_1' }] });
    const [c1, c2, c3] = calls;
    expect(JSON.parse(c1!.init.body as string)).toMatchObject({ product: 'degent', customerRef: 'cust', metadata: { a: 'b' } });
    expect((c1!.init.headers as Record<string, string>)['idempotency-key']).toBe('k1');
    expect((c1!.init.headers as Record<string, string>)['x-api-key']).toBe('bsh_ledger');
    expect(JSON.parse(c2!.init.body as string)).toEqual({ method: 'psbt', expiresAt: '2026-09-24T01:00:00.000Z' });
    expect((c2!.init.headers as Record<string, string>)['idempotency-key']).toBe('k2');
    expect(c3!.url).toBe('http://ledger.test/v1/payments/pay_1/observations');
    expect((c3!.init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
  });

  it('classifies errors: 409 payee_required is not retryable, 5xx and network are', async () => {
    const { fetch } = fakeFetch({
      'POST /v1/orders': () => json({ error: { code: 'payee_required', message: 'x' } }, 409),
      'POST /v1/orders/o/payments': () => new Response('nope', { status: 502 }),
    });
    const c = new HttpLedgerClient({ ledgerUrl: 'http://ledger.test', apiKey: 'k', fetch });
    await expect(c.createOrder({ customerRef: 'c', lineItems: [], idempotencyKey: 'k' })).rejects.toMatchObject({ name: 'LedgerClientError', status: 409, retryable: false });
    await expect(c.createPsbtPayment('o', { idempotencyKey: 'k' })).rejects.toMatchObject({ status: 502, retryable: true });
    const down = new HttpLedgerClient({ ledgerUrl: 'http://ledger.test', apiKey: 'k', fetch: async () => { throw new Error('reset'); } });
    await expect(down.observePayment('p', { txid: 'a'.repeat(64), outputs: [], confirmations: 0, rbfSignalled: false })).rejects.toBeInstanceOf(LedgerClientError);
  });
});

describe('MemoryLedgerClient', () => {
  it('is idempotent on the keys and refuses psbt intents on line items without payees', async () => {
    const l = new MemoryLedgerClient();
    const a = await l.createOrder({ customerRef: 'c', lineItems: [{ sku: 'x', description: 'x', quantity: 2, unitSats: 10, payee: { kind: 'club', ref: 'c', address: regtestAddress(5) } }], idempotencyKey: 'k' });
    const b = await l.createOrder({ customerRef: 'c', lineItems: [], idempotencyKey: 'k' });
    expect(b.id).toBe(a.id);
    expect(a.totalSats).toBe(20);
    const p1 = await l.createPsbtPayment(a.id, { idempotencyKey: 'p' });
    const p2 = await l.createPsbtPayment(a.id, { idempotencyKey: 'p' });
    expect(p2.id).toBe(p1.id);
    expect(p1.outputs).toEqual([{ scriptHex: expect.stringMatching(/^5120/), valueSats: 20, address: regtestAddress(5) }]);
    const noPayee = await l.createOrder({ customerRef: 'c', lineItems: [{ sku: 'x', description: 'x', quantity: 1, unitSats: 10 }], idempotencyKey: 'k2' });
    await expect(l.createPsbtPayment(noPayee.id, { idempotencyKey: 'p2' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('MemoryStudioClient', () => {
  it('serves content for approved artworks only and records royalties idempotently', async () => {
    const s = new MemoryStudioClient();
    const bytes = new Uint8Array([1, 2, 3]);
    s.addArtwork({ id: 'a', artist: ARTIST, payoutAddress: PAYOUT, bytes, contentType: 'image/png' });
    s.addArtwork({ id: 'b', artist: ARTIST, payoutAddress: PAYOUT, bytes, contentType: 'image/png', status: 'delisted' });
    expect(await s.getContent('a')).toEqual(bytes);
    expect(await s.getContent('b')).toBeNull();
    expect((await s.getArtwork('a'))!.contentLength).toBe(3);
    const rec = { orderId: 'o', artworkId: 'a', minterAddress: null, royaltySats: 330, fundingTxid: 'c'.repeat(64), vout: 1, at: 'x' };
    expect(await s.postRoyalty(rec)).toEqual({ created: true });
    expect(await s.postRoyalty(rec)).toEqual({ created: false });
    await expect(s.postRoyalty({ ...rec, royaltySats: 331 })).rejects.toMatchObject({ status: 409, retryable: false });
    await expect(s.postRoyalty({ ...rec, orderId: 'o2', artworkId: 'nope' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('isRbfSignalled (esplora)', () => {
  it('any input sequence below 0xfffffffe while unconfirmed', () => {
    expect(isRbfSignalled({ vin: [{ sequence: 0xfffffffd }], status: { confirmed: false } })).toBe(true);
    expect(isRbfSignalled({ vin: [{ sequence: 0xfffffffe }], status: { confirmed: false } })).toBe(false);
    expect(isRbfSignalled({ vin: [{ sequence: 0xfffffffd }], status: { confirmed: true } })).toBe(false);
    expect(isRbfSignalled({ status: { confirmed: false } })).toBe(false);
  });
});

const dir = mkdtempSync(join(tmpdir(), 'degent-editions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.each([
  ['memory', () => new MemoryOrderStore()],
  ['sqlite', () => new SqliteOrderStore(join(dir, `e-${Math.random()}.db`))],
])('MetaEditionStore over %s', (_n, make) => {
  const t0 = new Date('2026-09-24T00:00:00.000Z');
  const t = (s: number) => new Date(t0.getTime() + s * 1000);

  it('reserves 1, 2, 3; is idempotent per order; consumption is stable; release frees the number', async () => {
    const e = new MetaEditionStore(make());
    expect(await e.reserve('art', 'o1', t(900), t0)).toBe(1);
    expect(await e.reserve('art', 'o2', t(900), t0)).toBe(2);
    expect(await e.reserve('art', 'o1', t(950), t(1))).toBe(1);
    expect(await e.consume('art', 'o2', 2, t(2))).toBe(2);
    expect(await e.consume('art', 'o2', 2, t(3))).toBe(2);
    expect(await e.consumedCount('art')).toBe(1);
    await e.release('art', 'o1');
    expect(await e.reservation('art', 'o1')).toBeNull();
    await e.release('art', 'o2'); // consumed: no-op
    expect((await e.reservation('art', 'o2'))!.consumed).toBe(true);
    expect(await e.reserve('art', 'o3', t(900), t(4))).toBe(1); // the freed number
    expect(await e.reserve('art', 'o4', t(900), t(4))).toBe(3);
    expect(await e.consume('art', 'nope', 1, t(5))).toBeNull(); // held by o3
    expect(await e.consume('art', 'nope', 3, t(5))).toBeNull(); // held by o4
  });

  it('expired reservations are released lazily; a late consume keeps the number unless another order holds it', async () => {
    const e = new MetaEditionStore(make());
    await e.reserve('art', 'late', t(900), t0);
    expect(await e.reserve('art', 'next', t(2000), t(901))).toBe(1); // late's number, expired
    expect(await e.consume('art', 'late', 1, t(902))).toBeNull(); // lost
    expect(await e.reservation('art', 'late')).toBeNull();
    await e.reserve('art', 'late2', t(1800), t(903));
    expect(await e.consume('art', 'late2', 2, t(2500))).toBe(2); // expired but nobody took it: still theirs
    // released explicitly (quote expired), then a late payment re-claims the quoted number while it is free
    expect(await e.reserve('art', 'late3', t(3000), t(2501))).toBe(1); // 'next' expired at t(2000): 1 is the lowest free number again
    await e.release('art', 'late3');
    expect(await e.reservation('art', 'late3')).toBeNull();
    expect(await e.consume('art', 'late3', 1, t(4000))).toBe(1);
    expect(await e.consumedCount('art')).toBe(2);
  });

  it('a cap refuses NEW reservations once active + consumed reach it; re-reserving is idempotent at the cap (ADR-0012)', async () => {
    const e = new MetaEditionStore(make());
    const cap = { maxEditions: 2 };
    expect(await e.reserve('art', 'o1', t(900), t0, cap)).toBe(1);
    expect(await e.reserve('art', 'o2', t(900), t0, cap)).toBe(2);
    const err = await e.reserve('art', 'o3', t(900), t0, cap).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EditionsSoldOutError);
    expect(err).toMatchObject({ artworkId: 'art', maxEditions: 2, held: 2 });
    expect(await e.reservation('art', 'o3')).toBeNull();
    expect(await e.reserve('art', 'o1', t(950), t(1), cap)).toBe(1); // idempotent for an existing order
    expect(await e.countActive('art', t(1))).toBe(2);
    expect(await e.consume('art', 'o1', 1, t(2))).toBe(1);
    expect(await e.countActive('art', t(2))).toBe(2);
    // o2's quote expires: its slot frees, the consumed edition keeps counting
    expect(await e.countActive('art', t(901))).toBe(1);
    expect(await e.reserve('art', 'o4', t(1800), t(901), cap)).toBe(2);
    await expect(e.reserve('art', 'o5', t(1800), t(902), cap)).rejects.toBeInstanceOf(EditionsSoldOutError);
    // no cap / null cap: open edition
    expect(await e.reserve('art', 'o6', t(1800), t(903), { maxEditions: null })).toBe(3);
    expect(await e.reserve('art', 'o7', t(1800), t(903))).toBe(4);
    expect(await e.countActive('none', t0)).toBe(0);
  });

  it('concurrent reservations against a cap: exactly maxEditions succeed, with distinct numbers', async () => {
    const e = new MetaEditionStore(make());
    const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => e.reserve('art', `o${i}`, t(900), t0, { maxEditions: 5 })));
    const ok = res.filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled').map((r) => r.value);
    expect(ok.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(res.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof EditionsSoldOutError)).toBe(true);
    expect(await e.countActive('art', t0)).toBe(5);
  });

  it('concurrent reservations for one artwork never collide', async () => {
    const e = new MetaEditionStore(make());
    const nums = await Promise.all(Array.from({ length: 12 }, (_, i) => e.reserve('art', `o${i}`, t(900), t0)));
    expect([...nums].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const consumed = await Promise.all(Array.from({ length: 12 }, (_, i) => e.consume('art', `o${i}`, nums[i]!, t(1))));
    expect(new Set(consumed).size).toBe(12);
    expect(await e.consumedCount('art')).toBe(12);
    expect(await e.consumedCount('other')).toBe(0);
  });
});
