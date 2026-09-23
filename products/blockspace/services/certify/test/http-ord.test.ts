import { RawOldTx, RawTx } from '@scure/btc-signer';
import { describe, expect, it } from 'vitest';
import { HttpOrd, ordTransactionVsize } from '../src/adapters/http-ord.js';
import { OrdError } from '../src/ports/ord.js';

const ID = `${'a1'.repeat(32)}i0`;
const PARENT = `${'b2'.repeat(32)}i0`;

type Route = (path: string, init: RequestInit) => Response;
function ord(route: Route) {
  const calls: { path: string; accept: string | undefined }[] = [];
  const o = new HttpOrd({
    baseUrl: 'http://ord.test/',
    sleep: async () => {},
    fetch: async (url, init) => {
      const path = url.replace('http://ord.test', '');
      calls.push({ path, accept: (init.headers as Record<string, string>).accept });
      return route(path, init);
    },
  });
  return { o, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** Trimmed from ord 0.2x `GET /inscription/<id>` (Accept: application/json). */
const ordInscription = {
  address: 'bc1p…',
  charms: [],
  child_count: 0,
  children: [],
  content_length: 355_975,
  content_type: 'image/webp',
  effective_content_type: 'image/webp',
  fee: 90_123,
  height: 840_123,
  id: ID,
  next: null,
  number: 93_832_030,
  parents: [PARENT],
  previous: null,
  rune: null,
  sat: 969_669_989_966_969,
  satpoint: `${'a1'.repeat(32)}:0:0`,
  timestamp: 1_713_600_000,
  value: 546,
  metaprotocol: null,
};

describe('HttpOrd', () => {
  it('maps /inscription JSON and asks for JSON', async () => {
    const { o, calls } = ord(() => json(ordInscription));
    expect(await o.inscription(ID)).toEqual({ id: ID, number: 93_832_030, height: 840_123, contentLength: 355_975, contentType: 'image/webp', parents: [PARENT] });
    expect(calls[0]).toEqual({ path: `/inscription/${ID}`, accept: 'application/json' });
  });

  it('reads the legacy single `parent` field', async () => {
    const { parents: _p, ...legacy } = ordInscription;
    const { o } = ord(() => json({ ...legacy, parent: PARENT }));
    expect((await o.inscription(ID))!.parents).toEqual([PARENT]);
  });

  it('404 → null; wrong shape → OrdError (fails loudly)', async () => {
    expect(await ord(() => new Response('not found', { status: 404 })).o.inscription(ID)).toBeNull();
    await expect(ord(() => json({ ...ordInscription, number: '1' })).o.inscription(ID)).rejects.toThrow(/unexpected number/);
    await expect(ord(() => json({ ...ordInscription, id: PARENT })).o.inscription(ID)).rejects.toThrow(/unexpected id/);
    await expect(ord(() => new Response('<html>', { status: 200 })).o.inscription(ID)).rejects.toThrow(/non-JSON/);
    await expect(ord(() => json({})).o.inscription('bad')).rejects.toBeInstanceOf(OrdError);
  });

  it('children pages use the recursive JSON endpoint', async () => {
    const { o, calls } = ord(() => json({ ids: [ID], more: true, page: 2 }));
    expect(await o.children(PARENT, 2)).toEqual({ ids: [ID], more: true, page: 2 });
    expect(calls[0]!.path).toBe(`/r/children/${PARENT}/2`);
    await expect(ord(() => json({ ids: ['x'], more: false })).o.children(PARENT, 0)).rejects.toThrow(/unexpected body/);
  });

  it('blockheight, content bytes', async () => {
    expect(await ord(() => json(915_012)).o.blockHeight()).toBe(915_012);
    await expect(ord(() => json('915012')).o.blockHeight()).rejects.toBeInstanceOf(OrdError);
    const bytes = new Uint8Array([1, 2, 3]);
    const { o, calls } = ord(() => new Response(bytes));
    expect(await o.content(ID)).toEqual(bytes);
    expect(calls[0]).toEqual({ path: `/content/${ID}`, accept: '*/*' });
  });

  it('retries 5xx, not 4xx', async () => {
    let n = 0;
    const flaky = ord(() => (++n < 3 ? new Response('busy', { status: 503 }) : json(1)));
    expect(await flaky.o.blockHeight()).toBe(1);
    expect(flaky.calls).toHaveLength(3);
    const bad = ord(() => new Response('bad', { status: 400 }));
    await expect(bad.o.blockHeight()).rejects.toMatchObject({ status: 400 });
    expect(bad.calls).toHaveLength(1);
  });
});

describe('ordTransactionVsize', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

  /** Builds a tx with btc-signer, then renders it the way ord's serde does, and compares vsize. */
  function check(inputs: { scriptSig: number; witness: number[] }[], outputs: number[]) {
    const ins = inputs.map((i, k) => ({ txid: fill(32, k + 1), index: k, finalScriptSig: fill(i.scriptSig, 0x51), sequence: 0xfffffffd }));
    const outs = outputs.map((len, k) => ({ amount: BigInt(546 + k), script: fill(len, 0x6a) }));
    const witnesses = inputs.map((i) => i.witness.map((len) => fill(len, 0xcc)));
    const segwit = witnesses.some((w) => w.length > 0);
    const full = RawTx.encode({ version: 2, segwitFlag: segwit, inputs: ins, outputs: outs, witnesses: segwit ? witnesses : undefined, lockTime: 0 });
    const base = RawOldTx.encode({ version: 2, inputs: ins, outputs: outs, lockTime: 0 });
    const expectedVsize = Math.ceil((base.length * 3 + full.length) / 4); // BIP141 weight = base*3 + total
    const ordJson = {
      version: 2,
      lock_time: 0,
      input: ins.map((i, k) => ({
        previous_output: `${hex(i.txid)}:${i.index}`,
        script_sig: hex(i.finalScriptSig),
        sequence: i.sequence,
        witness: witnesses[k]!.map(hex),
      })),
      output: outs.map((o) => ({ value: Number(o.amount), script_pubkey: hex(o.script) })),
    };
    expect(ordTransactionVsize(ordJson)).toBe(expectedVsize);
  }

  it('matches BIP141 weight for inscription-like reveals, from 1 byte to a block-sized envelope', () => {
    for (const envelope of [1, 520, 75, 252, 253, 65_535, 65_536, 400_000, 3_962_660])
      check([{ scriptSig: 0, witness: [64, envelope, 33] }], [34]);
  });

  it('matches for parent-linked reveals, mixed legacy/segwit inputs and many outputs', () => {
    check([{ scriptSig: 0, witness: [64] }, { scriptSig: 0, witness: [65, 360_000, 33] }], [34, 34]);
    check([{ scriptSig: 107, witness: [] }, { scriptSig: 0, witness: [72, 33] }], [22, 25, 34, 80]);
    check([{ scriptSig: 107, witness: [] }], [25]); // legacy only: no marker/flag
    check([{ scriptSig: 0, witness: [64] }], Array.from({ length: 300 }, () => 34)); // 3-byte output count
  });

  it('rejects shapes it does not understand', () => {
    expect(() => ordTransactionVsize({ input: 'x', output: [] })).toThrow(OrdError);
    expect(() => ordTransactionVsize({ input: [{ script_sig: 'zz', witness: [] }], output: [] })).toThrow(/script_sig/);
  });
});
