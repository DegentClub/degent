/** HTTP adapters against a mocked fetch: esplora chain, ord indexer, membership (roster+ord, mint Register). */
import { describe, expect, it, vi } from 'vitest';
import { EsploraMarketChain } from '../src/adapters/esplora-chain.js';
import { MintRegisterMembership, RosterOrdMembership } from '../src/adapters/memberships.js';
import { OrdRecursiveIndexer } from '../src/adapters/ord-indexer.js';
import { BroadcastRejected, UpstreamError } from '../src/ports/chain.js';
import { INSCRIPTION_ID, TXIDS } from './fakes/keys.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const routes = (table: Record<string, () => Response>) =>
  vi.fn(async (url: string) => {
    for (const [suffix, r] of Object.entries(table)) if (url.endsWith(suffix)) return r();
    return json({}, 404);
  });

describe('EsploraMarketChain', () => {
  it('maps outspend, tx, utxos, fees and broadcast', async () => {
    const f = routes({
      [`/tx/${TXIDS.inscription}/outspend/1`]: () => json({ spent: true, txid: 'cc'.repeat(32) }),
      [`/tx/${'cc'.repeat(32)}`]: () => json({ txid: 'cc'.repeat(32), vout: [{ scriptpubkey: '5120ab', scriptpubkey_address: 'bcrt1pseller', value: 50_000 }], status: { confirmed: true } }),
      '/address/bcrt1pbuyer/utxo': () => json([{ txid: TXIDS.pay1, vout: 0, value: 400_000, status: { confirmed: false } }]),
      '/v1/fees/recommended': () => json({ fastestFee: 9 }),
    });
    const c = new EsploraMarketChain({ esploraUrl: 'https://esplora.test/api/', fetch: f });
    expect(await c.getOutspend(TXIDS.inscription, 1)).toEqual({ spent: true, txid: 'cc'.repeat(32) });
    expect(await c.getOutspend(TXIDS.pay2, 0)).toBeNull();
    expect((await c.getTx('cc'.repeat(32)))!.vout[0]).toEqual({ value: 50_000n, scriptHex: '5120ab', address: 'bcrt1pseller' });
    expect(await c.getAddressUtxos('bcrt1pbuyer')).toEqual([{ txid: TXIDS.pay1, vout: 0, value: 400_000n, confirmed: false }]);
    expect(await c.getFeeRecommendations()).toEqual({ fastestFee: 9 });
  });

  it('broadcast: txid on success, BroadcastRejected on 400, UpstreamError on 5xx / network failure', async () => {
    const ok = new EsploraMarketChain({ esploraUrl: 'https://e', fetch: async () => new Response('ab'.repeat(32)) });
    expect(await ok.broadcast('00')).toBe('ab'.repeat(32));
    const rej = new EsploraMarketChain({ esploraUrl: 'https://e', fetch: async () => new Response('sendrawtransaction RPC error', { status: 400 }) });
    await expect(rej.broadcast('00')).rejects.toBeInstanceOf(BroadcastRejected);
    const down = new EsploraMarketChain({ esploraUrl: 'https://e', fetch: async () => new Response('', { status: 503 }) });
    await expect(down.broadcast('00')).rejects.toBeInstanceOf(UpstreamError);
    const net = new EsploraMarketChain({ esploraUrl: 'https://e', fetch: async () => { throw new Error('ECONNRESET'); } });
    await expect(net.getOutspend('x', 0)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('OrdRecursiveIndexer', () => {
  it('parses /r/inscription (satpoint offset, output, value, owner) and /r/utxo', async () => {
    const f = routes({
      [`/r/inscription/${INSCRIPTION_ID}`]: () => json({ id: INSCRIPTION_ID, number: 7, address: 'bcrt1pseller', satpoint: `${TXIDS.inscription}:1:42`, output: `${TXIDS.inscription}:1`, value: 10_000, content_type: 'image/webp' }),
      [`/r/utxo/${encodeURIComponent(`${TXIDS.pay1}:0`)}`]: () => json({ inscriptions: ['x'] }),
    });
    const o = new OrdRecursiveIndexer({ ordUrl: 'https://ord.test', fetch: f });
    expect(await o.getInscription(INSCRIPTION_ID)).toEqual({ id: INSCRIPTION_ID, number: 7, address: 'bcrt1pseller', outpoint: `${TXIDS.inscription}:1`, offset: 42, value: 10_000, contentType: 'image/webp' });
    expect(await o.getInscription(`${'0'.repeat(64)}i0`)).toBeNull();
    expect(await o.getOutpointInscriptions(`${TXIDS.pay1}:0`)).toEqual(['x']);
    expect(await o.getOutpointInscriptions(`${TXIDS.pay2}:0`)).toEqual([]);
    const down = new OrdRecursiveIndexer({ ordUrl: 'https://ord.test', fetch: async () => json({}, 500) });
    await expect(down.getInscription(INSCRIPTION_ID)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('CollectionMembership adapters', () => {
  const PARENT = `${'9a'.repeat(32)}i0`;
  const CHILD = `${'c1'.repeat(32)}i0`;

  it('roster + ord: Gallery members by roster, children by /r/parents, everything else refused', async () => {
    const f = routes({
      [`/r/parents/${CHILD}`]: () => json({ ids: [PARENT], more: false, page: 0 }),
      [`/r/parents/${'d0'.repeat(32)}i0`]: () => json({ ids: [`${'77'.repeat(32)}i0`], more: false, page: 0 }),
    });
    const m = new RosterOrdMembership([{ n: 1, inscriptionId: INSCRIPTION_ID }], { ordUrl: 'https://ord.test', parentInscriptionId: PARENT, fetch: f });
    expect(await m.lookup(INSCRIPTION_ID)).toEqual({ via: 'gallery', n: 1 });
    expect(await m.lookup(CHILD)).toEqual({ via: 'child', n: null });
    expect(await m.lookup(CHILD)).toEqual({ via: 'child', n: null });
    expect(f.mock.calls.filter(([u]) => String(u).includes(CHILD))).toHaveLength(1); // cached
    expect(await m.lookup(`${'d0'.repeat(32)}i0`)).toBeNull(); // child of another parent
    expect(await m.lookup(`${'e0'.repeat(32)}i0`)).toBeNull(); // unknown to ord
    const noParent = new RosterOrdMembership([], { ordUrl: 'https://ord.test', parentInscriptionId: null, fetch: f });
    expect(await noParent.lookup(CHILD)).toBeNull();
  });

  it('mint Register via @bsh/degent-mint-sdk: member → ref, non-member → null, outage → UpstreamError', async () => {
    const f = routes({
      [`/v1/register/verify/${INSCRIPTION_ID}`]: () => json({ id: INSCRIPTION_ID, member: true, via: 'gallery', n: 1 }),
      [`/v1/register/verify/${CHILD}`]: () => json({ id: CHILD, member: true, via: 'child', n: 4113 }),
      [`/v1/register/verify/${'e0'.repeat(32)}i0`]: () => json({ id: 'x', member: false, via: null, n: null }),
    });
    const m = new MintRegisterMembership({ mintApiUrl: 'https://mint.test', fetch: f });
    expect(await m.lookup(INSCRIPTION_ID)).toEqual({ via: 'gallery', n: 1 });
    expect(await m.lookup(CHILD)).toEqual({ via: 'child', n: 4113 });
    expect(await m.lookup(`${'e0'.repeat(32)}i0`)).toBeNull();
    const down = new MintRegisterMembership({ mintApiUrl: 'https://mint.test', fetch: async () => json({ error: { code: 'internal', message: 'x' } }, 500) });
    await expect(down.lookup(INSCRIPTION_ID)).rejects.toBeInstanceOf(UpstreamError);
  });
});
