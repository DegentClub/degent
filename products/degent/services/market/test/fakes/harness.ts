/**
 * Test harness: the full service (API + watcher) on in-memory adapters, a fake chain / ord indexer /
 * clock, and a "wallet" that signs PSBTs and BIP-322 messages with test keys (@bsh/identity signer).
 * Nothing touches a network.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { InMemoryNonceStore, signBip322Simple } from '@bsh/identity';
import type { ListingStatusEvent } from '@bsh/degent-market-sdk';
import { MarketAuth } from '../../src/application/auth.js';
import { ListingLifecycle } from '../../src/application/lifecycle.js';
import { MarketService } from '../../src/application/market-service.js';
import type { MarketSettings } from '../../src/application/settings.js';
import { SettlementWatcher } from '../../src/application/settlement-watcher.js';
import { createApp } from '../../src/app.js';
import { MemoryMarketStore } from '../../src/adapters/memory-store.js';
import { MemoryMembership } from '../../src/adapters/memberships.js';
import { MemoryEventBus } from '../../src/adapters/system.js';
import { SELLER_SIGHASH } from '../../src/domain/settlement/index.js';
import { BroadcastRejected, UpstreamError, type AddressUtxo, type ChainTx, type MarketChain, type Outspend } from '../../src/ports/chain.js';
import type { InscriptionLocation, OrdIndexer } from '../../src/ports/ord.js';
import { INSCRIPTION_ID, NET, TXIDS, keyFromSeed, walletSign, type TestKey } from './keys.js';

export class FakeClock {
  t = Date.parse('2026-09-24T12:00:00.000Z');
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeChain implements MarketChain {
  spent = new Map<string, string>();
  txs = new Map<string, ChainTx>();
  utxos = new Map<string, AddressUtxo[]>();
  unknownOutpoints = new Set<string>();
  fees: Record<string, unknown> = { fastestFee: 20, halfHourFee: 10, hourFee: 6, economyFee: 3, minimumFee: 1 };
  broadcasts: Array<{ rawHex: string; txid: string }> = [];
  down = false;
  rejectBroadcast: string | null = null;

  private guard() {
    if (this.down) throw new UpstreamError('chain down');
  }
  async getOutspend(txid: string, vout: number): Promise<Outspend | null> {
    this.guard();
    const k = `${txid}:${vout}`;
    if (this.unknownOutpoints.has(k)) return null;
    const s = this.spent.get(k);
    return s ? { spent: true, txid: s } : { spent: false, txid: null };
  }
  async getTx(txid: string): Promise<ChainTx | null> {
    this.guard();
    return this.txs.get(txid) ?? null;
  }
  async getAddressUtxos(address: string): Promise<AddressUtxo[]> {
    this.guard();
    return this.utxos.get(address) ?? [];
  }
  async getFeeRecommendations() {
    this.guard();
    return this.fees;
  }
  async broadcast(rawHex: string): Promise<string> {
    this.guard();
    if (this.rejectBroadcast) throw new BroadcastRejected(this.rejectBroadcast);
    const txid = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true }).id;
    this.broadcasts.push({ rawHex, txid });
    return txid;
  }
  /** Make the network "see" a broadcast: spend its inputs and index its outputs by address. */
  confirm(rawHex: string, addressOf: (scriptHex: string) => string | null): string {
    const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true });
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      this.spent.set(`${hex.encode(inp.txid!)}:${inp.index}`, tx.id);
    }
    const vout = [];
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      const scriptHex = hex.encode(o.script!);
      vout.push({ value: o.amount!, scriptHex, address: addressOf(scriptHex) });
    }
    this.txs.set(tx.id, { txid: tx.id, vout, confirmed: true });
    return tx.id;
  }
}

export class FakeOrd implements OrdIndexer {
  inscriptions = new Map<string, InscriptionLocation>();
  inscribed = new Set<string>();
  down = false;
  async getInscription(id: string): Promise<InscriptionLocation | null> {
    if (this.down) throw new UpstreamError('ord down');
    const i = this.inscriptions.get(id);
    return i ? { ...i } : null;
  }
  async getOutpointInscriptions(outpoint: string): Promise<string[]> {
    if (this.down) throw new UpstreamError('ord down');
    return this.inscribed.has(outpoint) ? ['some-inscription'] : [];
  }
}

export const LOC = `${TXIDS.inscription}:1`;
export const SIWB_DOMAIN = 'market.degent.test';

export interface HarnessOptions {
  settings?: Partial<MarketSettings>;
  corsOrigins?: string[];
  rateLimit?: { windowMs: number; max: number };
}

export function makeHarness(opts: HarnessOptions = {}) {
  const seller = keyFromSeed('seller');
  const buyer = keyFromSeed('buyer');
  const treasury = keyFromSeed('treasury');
  const clock = new FakeClock();
  const chain = new FakeChain();
  const ord = new FakeOrd();
  ord.inscriptions.set(INSCRIPTION_ID, { id: INSCRIPTION_ID, number: 1, address: seller.tr.address, outpoint: LOC, offset: 0, value: 10_000, contentType: 'image/webp' });
  chain.utxos.set(buyer.tr.address, [
    { txid: TXIDS.dummy, vout: 0, value: 600n, confirmed: true },
    { txid: TXIDS.dummy, vout: 1, value: 700n, confirmed: true },
    { txid: TXIDS.pay1, vout: 0, value: 400_000n, confirmed: true },
  ]);
  const membership = new MemoryMembership([[INSCRIPTION_ID, { via: 'gallery', n: 1 }]]);
  const store = new MemoryMarketStore();
  const nonces = new InMemoryNonceStore();
  const events = new MemoryEventBus();
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const settings: MarketSettings = {
    network: NET,
    version: 'test',
    buysEnabled: false,
    royaltyBps: 0,
    treasuryAddress: null,
    priceMinSats: 1000,
    priceMaxSats: 100 * 100_000_000,
    listingMaxDays: 30,
    dummyValueSats: 600,
    challengeTtlSeconds: 600,
    buySessionTtlSeconds: 600,
    pendingTimeoutMs: 6 * 3600_000,
    utxoSafetyCheck: true,
    explorerTxUrl: 'https://mempool.test/tx',
    auth: { domain: SIWB_DOMAIN, uri: null },
    ...opts.settings,
  };
  const lifecycle = new ListingLifecycle({ store, events, clock, network: NET, log });
  const auth = new MarketAuth({ nonces, clock, network: NET, domain: SIWB_DOMAIN, uri: null, ttlSeconds: settings.challengeTtlSeconds, log });
  let n = 0;
  const market = new MarketService({ settings, listings: store, sessions: store, chain, ord, membership, auth, lifecycle, clock, log, newId: () => (++n).toString(16).padStart(32, '0') });
  const watcher = new SettlementWatcher({ settings, listings: store, chain, ord, lifecycle, clock, log, purgeSessions: () => market.purgeSessions() });
  const app = createApp({ market, clock, corsOrigins: opts.corsOrigins ?? [], rateLimit: opts.rateLimit ?? { windowMs: 60_000, max: 10_000 }, log, clientIp: () => '203.0.113.9' });

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  const addressOf = (scriptHex: string) =>
    [seller, buyer, treasury].flatMap((k) => [[k.tr.script, k.tr.address], [k.wpkh.script, k.wpkh.address]] as const).find(([s]) => hex.encode(s) === scriptHex)?.[1] ?? null;

  return { seller, buyer, treasury, clock, chain, ord, membership, store, nonces, events, settings, market, watcher, app, request, addressOf, events_: events.events as ListingStatusEvent[] };
}

export type Harness = ReturnType<typeof makeHarness>;

/** Sign a SIWB message the way a wallet does (`signMessage(msg, 'bip322-simple')`). */
export const bip322 = (k: TestKey, message: string, kind: 'p2tr' | 'p2wpkh' = 'p2tr') => signBip322Simple(k.priv, kind, message);

/** The whole seller flow through the API: prepare → sign 0x83 → challenge → BIP-322 → create. */
export async function listViaApi(h: Harness, priceSats = 50_000, who: TestKey = h.seller) {
  const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: who.tr.address, sellerPublicKey: who.publicKeyHex, priceSats });
  if (prep.status !== 200) return prep;
  const signedPsbt = walletSign(prep.body.psbtHex, who.priv, [2], SELLER_SIGHASH);
  const ch = await h.request('POST', '/v1/auth/challenge', { action: 'list', address: who.tr.address, inscriptionId: INSCRIPTION_ID, priceSats });
  const signature = bip322(who, ch.body.message);
  return h.request('POST', '/v1/listings', { inscriptionId: INSCRIPTION_ID, sellerAddress: who.tr.address, sellerPublicKey: who.publicKeyHex, priceSats, signedPsbt, message: ch.body.message, signature });
}
