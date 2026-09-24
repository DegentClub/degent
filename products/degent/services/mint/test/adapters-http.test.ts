/** HTTP adapters against canned responses (no network). */
import { describe, expect, it } from 'vitest';
import { EsploraChain } from '../src/adapters/esplora-chain.js';
import { EsploraFees } from '../src/adapters/fees.js';
import { EsploraBroadcaster, FanoutBroadcaster, LibreRelayBroadcaster, SlipstreamBroadcaster } from '../src/adapters/broadcasters.js';

type Handler = (url: string, init?: RequestInit) => Response;
function fetchOf(handler: Handler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}
const TXID = 'ab'.repeat(32);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe('EsploraChain', () => {
  it('maps esplora + ord responses', async () => {
    const f = fetchOf((url) => {
      if (url.endsWith(`/tx/${TXID}`)) return json({ txid: TXID, vout: [{ scriptpubkey: '5120aa', scriptpubkey_address: 'bcrt1p', value: 1234 }], status: { confirmed: true, block_height: 7 } });
      if (url.endsWith('/outspends')) return json([{ spent: true, txid: 'cd'.repeat(32), vin: 1 }, { spent: false }]);
      if (url.endsWith('/utxo')) return json([{ txid: TXID, vout: 0, value: 5, status: { confirmed: false } }]);
      if (url.endsWith('/blocks/tip/height')) return new Response('812345');
      if (url.includes('/content/')) return url.includes('missing') ? new Response('', { status: 404 }) : new Response(new Uint8Array([1, 2, 3]));
      return new Response('', { status: 404 });
    });
    const c = new EsploraChain({ esploraUrl: 'http://esplora/api/', ordUrl: 'http://ord', fetch: f.fetch });
    expect(await c.getTx(TXID)).toEqual({ txid: TXID, vout: [{ value: 1234n, scriptHex: '5120aa', address: 'bcrt1p' }], confirmed: true, blockHeight: 7, rbfSignalled: false });
    expect(await c.getTx('00'.repeat(32))).toBeNull();
    expect(await c.getTxOutspends(TXID)).toEqual([{ spent: true, txid: 'cd'.repeat(32), vin: 1 }, { spent: false, txid: null, vin: null }]);
    expect(await c.findOutputsPaying('bcrt1p')).toEqual([{ txid: TXID, vout: 0, value: 5n, confirmed: false }]);
    expect(await c.getTipHeight()).toBe(812345);
    expect(await c.getInscriptionContent(`${TXID}i0`)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await c.getInscriptionContent('missing')).toBeNull();
    expect(f.calls[0]!.url).toBe(`http://esplora/api/tx/${TXID}`);
  });

  it('throws on 5xx so the worker retries', async () => {
    const c = new EsploraChain({ esploraUrl: 'http://e', ordUrl: 'http://o', fetch: fetchOf(() => new Response('', { status: 502 })).fetch });
    await expect(c.getTx(TXID)).rejects.toThrow(/502/);
  });
});

describe('EsploraFees', () => {
  it('picks targets, clamps to the minimum and caches', async () => {
    const f = fetchOf(() => json({ '1': 12.34, '6': 5, '144': 0.5 }));
    let now = 0;
    const fees = new EsploraFees({ esploraUrl: 'http://e', minFeeRate: 1, fetch: f.fetch, now: () => now });
    const r = await fees.getFees();
    expect(r.standard).toEqual({ slow: 1, normal: 5, fast: 12.4 });
    expect(r.block).toEqual({ min: 1, recommended: 12.4 });
    await fees.getFees();
    expect(f.calls).toHaveLength(1);
    now = 60_000;
    await fees.getFees();
    expect(f.calls).toHaveLength(2);
  });
});

describe('broadcasters', () => {
  it('esplora: POST /tx, txid on success, classification on failure', async () => {
    const ok = new EsploraBroadcaster({ esploraUrl: 'http://e', fetch: fetchOf(() => new Response(TXID)).fetch });
    expect(await ok.broadcast('00')).toEqual({ ok: true, txid: TXID, via: 'esplora' });
    const perm = new EsploraBroadcaster({ esploraUrl: 'http://e', fetch: fetchOf(() => new Response('sendrawtransaction RPC error: bad-txns-inputs-missingorspent', { status: 400 })).fetch });
    expect(await perm.broadcast('00')).toMatchObject({ ok: false, retryable: false });
    const known = new EsploraBroadcaster({ esploraUrl: 'http://e', txid: () => TXID, fetch: fetchOf(() => new Response('txn-already-in-mempool', { status: 400 })).fetch });
    expect(await known.broadcast('00')).toEqual({ ok: true, txid: TXID, via: 'esplora' });
    const down = new EsploraBroadcaster({ esploraUrl: 'http://e', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await down.broadcast('00')).toMatchObject({ ok: false, retryable: true });
  });

  it('libre relay: JSON-RPC sendrawtransaction with basic auth', async () => {
    const f = fetchOf(() => json({ result: TXID, error: null }));
    const b = new LibreRelayBroadcaster({ rpcUrl: 'http://10.40.0.227:8332', user: 'u', password: 'p', fetch: f.fetch });
    expect(await b.broadcast('beef')).toEqual({ ok: true, txid: TXID, via: 'libre-relay' });
    const init = f.calls[0]!.init!;
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ method: 'sendrawtransaction', params: ['beef', 0] });
    const err = new LibreRelayBroadcaster({ rpcUrl: 'http://x', user: '', password: '', fetch: fetchOf(() => json({ result: null, error: { code: -26, message: 'dust' } }, 500)).fetch });
    expect(await err.broadcast('beef')).toMatchObject({ ok: false, retryable: false, error: 'dust' });
  });

  it('slipstream: POST /api/transactions with bearer key', async () => {
    const f = fetchOf(() => json({ message: 'accepted' }));
    const b = new SlipstreamBroadcaster({ url: 'https://slipstream.mara.com/', apiKey: 'k', txid: () => TXID, fetch: f.fetch });
    expect(await b.broadcast('beef')).toEqual({ ok: true, txid: TXID, via: 'slipstream' });
    expect(f.calls[0]!.url).toBe('https://slipstream.mara.com/api/transactions');
    expect(JSON.parse(f.calls[0]!.init!.body as string)).toEqual({ tx_hex: 'beef' });
    expect((f.calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('fanout succeeds if any path accepts', async () => {
    const bad = new EsploraBroadcaster({ esploraUrl: 'http://e', fetch: fetchOf(() => new Response('nope', { status: 500 })).fetch });
    const good = new LibreRelayBroadcaster({ rpcUrl: 'http://x', user: '', password: '', fetch: fetchOf(() => json({ result: TXID })).fetch });
    expect(await new FanoutBroadcaster([bad, good]).broadcast('00')).toMatchObject({ ok: true, via: 'libre-relay' });
    const both = await new FanoutBroadcaster([bad, bad]).broadcast('00');
    expect(both).toMatchObject({ ok: false, retryable: true, via: 'esplora+esplora' });
  });
});
