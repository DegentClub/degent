import { describe, expect, it } from 'vitest';
import { RosterChainHolderRegistry } from '../src/adapters/roster-chain-holder-registry.js';
import { MemoryHolderRegistry } from '../src/adapters/memory-holder-registry.js';
import { FakeClock } from './fakes/misc.js';

const id = (n: number) => `${n.toString(16).padStart(64, '0')}i0`;
const roster = [1, 2, 3].map((n) => ({ n, inscriptionId: id(n) }));

/** Fake esplora + ord: `utxos` per address, `inscriptions` per outpoint, `owner` per inscription id. */
function fakeChain(state: { utxos: Record<string, Array<{ txid: string; vout: number }>>; inscriptions: Record<string, string[]>; owner: Record<string, string | null> }) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    let m: RegExpExecArray | null;
    if ((m = /^https:\/\/esplora\.test\/address\/([^/]+)\/utxo$/.exec(url))) return json(state.utxos[m[1]!] ?? []);
    if ((m = /^https:\/\/ord\.test\/r\/utxo\/([^/]+)$/.exec(url))) {
      const list = state.inscriptions[decodeURIComponent(m[1]!)];
      return list ? json({ value: 546, inscriptions: list, runes: {}, sat_ranges: null }) : json({ error: 'not found' }, 404);
    }
    if ((m = /^https:\/\/ord\.test\/r\/inscription\/([^/]+)$/.exec(url))) {
      const o = state.owner[m[1]!];
      return o === undefined ? json({}, 404) : json({ id: m[1], address: o, height: 900_000 });
    }
    return json({ error: 'unexpected' }, 500);
  };
  return { fetch, calls };
}

describe('RosterChainHolderRegistry', () => {
  const alice = 'bc1p_alice';
  const bob = 'bc1p_bob';
  const state = {
    utxos: { [alice]: [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: 'ab'.repeat(32), vout: 1 }], [bob]: [{ txid: 'bb'.repeat(32), vout: 0 }] },
    inscriptions: { [`${'aa'.repeat(32)}:0`]: [id(2), 'ff'.repeat(32) + 'i0'], [`${'ab'.repeat(32)}:1`]: [id(1)], [`${'bb'.repeat(32)}:0`]: [] },
    owner: { [id(1)]: alice, [id(2)]: alice, [id(3)]: null },
  };

  it('isHolder intersects the address UTXOs\' inscriptions with the roster', async () => {
    const { fetch, calls } = fakeChain(state);
    const reg = new RosterChainHolderRegistry(roster, { esploraUrl: 'https://esplora.test/', ordUrl: 'https://ord.test', fetch });
    expect(await reg.isHolder(alice)).toEqual({ degents: [1, 2] });
    expect(await reg.isHolder(bob)).toEqual({ degents: [] });
    expect(await reg.isHolder('bc1p_nobody')).toEqual({ degents: [] });
    expect(calls.filter((c) => c.includes('/r/utxo/'))).toHaveLength(3);
  });

  it('holderOf reads ord /r/inscription, caches for the TTL, and reports unknown owners as null', async () => {
    const clock = new FakeClock();
    const { fetch, calls } = fakeChain(state);
    const reg = new RosterChainHolderRegistry(roster, { esploraUrl: 'https://esplora.test', ordUrl: 'https://ord.test', fetch, clock, cacheSeconds: 60 });
    expect(await reg.holderOf(1)).toBe(alice);
    expect(await reg.holderOf(1)).toBe(alice);
    expect(calls.filter((c) => c.includes('/r/inscription/'))).toHaveLength(1);
    clock.advance(61);
    expect(await reg.holderOf(1)).toBe(alice);
    expect(calls.filter((c) => c.includes('/r/inscription/'))).toHaveLength(2);
    expect(await reg.holderOf(3)).toBeNull();
    expect(await reg.holderOf(99)).toBeNull();
  });

  it('isHolder primes the owner cache; an ord outage yields no members rather than an exception', async () => {
    const { fetch, calls } = fakeChain(state);
    const reg = new RosterChainHolderRegistry(roster, { esploraUrl: 'https://esplora.test', ordUrl: 'https://ord.test', fetch });
    await reg.isHolder(alice);
    const before = calls.length;
    expect(await reg.holderOf(2)).toBe(alice);
    expect(calls.length).toBe(before);
    const down = new RosterChainHolderRegistry(roster, { esploraUrl: 'https://esplora.test', ordUrl: 'https://ord.test', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(down.isHolder(alice)).rejects.toThrow('ECONNREFUSED');
    expect(await down.holderOf(1)).toBeNull();
  });

  it('newly delivered children join the roster at runtime', async () => {
    const { fetch } = fakeChain({ ...state, inscriptions: { ...state.inscriptions, [`${'bb'.repeat(32)}:0`]: [id(4113)] } });
    const reg = new RosterChainHolderRegistry(roster, { esploraUrl: 'https://esplora.test', ordUrl: 'https://ord.test', fetch });
    expect(await reg.isHolder(bob)).toEqual({ degents: [] });
    reg.add(4113, id(4113));
    expect(reg.size).toBe(4);
    expect(await reg.isHolder(bob)).toEqual({ degents: [4113] });
  });
});

describe('MemoryHolderRegistry', () => {
  it('set / transfer / lookups', async () => {
    const m = new MemoryHolderRegistry();
    m.set('a', [3, 1]);
    expect(await m.isHolder('a')).toEqual({ degents: [1, 3] });
    expect(await m.holderOf(3)).toBe('a');
    m.transfer(3, 'b');
    expect(await m.isHolder('a')).toEqual({ degents: [1] });
    expect(await m.isHolder('b')).toEqual({ degents: [3] });
    expect(await m.holderOf(3)).toBe('b');
    expect(await m.holderOf(9)).toBeNull();
  });
});
