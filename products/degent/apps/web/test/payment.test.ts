import { describe, expect, it } from 'vitest';
import { createKeyVault, type KeyVault } from '../src/flow/keyVault';
import {
  FundingTxidMismatchError,
  MissingBundleError,
  MissingKeyError,
  MissingTokenError,
  openOrder,
  preparePayment,
  rescue,
  RescueInputsMismatchError,
  signAndBroadcast,
  verifyCommit,
} from '../src/flow/effects';
import { base64ToBytes, loadRecovery } from '../src/lib/recovery';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fakes, memoryStore, stateAtQuote, testApp } from './helpers';

/** Vault that records discards into the shared call log. */
function loggingVault(log: string[]): KeyVault {
  const v = createKeyVault();
  return {
    ...v,
    discard(id) {
      log.push('vault.discard');
      v.discard(id);
    },
  };
}

async function setup(opts: Parameters<typeof fakes>[0] = {}) {
  const log: string[] = [];
  const services = fakes({ log, ...opts });
  const app = testApp();
  const vault = loggingVault(log);
  const { state } = await stateAtQuote(services, app, vault);
  const store = memoryStore(log);
  return { log, services, app, vault, state, store };
}

describe('pay sequence', () => {
  it('POSTs the reveal and saves recovery BEFORE the wallet is asked to sign, and wipes K_e in between', async () => {
    const { log, services, app, vault, state, store } = await setup();
    const order = state.order!;
    expect(vault.get(order.id)).not.toBeNull();
    log.length = 0;

    const prepared = await preparePayment(
      { services, vault, app, store },
      { order, artwork: state.artwork!, wallet: state.wallet!, config: state.config! },
    );
    const txid = await signAndBroadcast({ services }, { wallet: state.wallet!, funding: prepared.funding });

    const at = (name: string) => log.indexOf(name);
    expect(at('chain.getUtxos')).toBeGreaterThanOrEqual(0);
    expect(at('inscription.buildHalfSignedReveal')).toBeGreaterThan(at('chain.getUtxos'));
    expect(at('api.submitReveal')).toBeGreaterThan(at('inscription.buildHalfSignedReveal'));
    expect(at('store.setItem')).toBeGreaterThan(at('api.submitReveal'));
    expect(at('vault.discard')).toBeGreaterThan(at('store.setItem'));
    expect(at('wallet.signPsbt')).toBeGreaterThan(at('vault.discard'));
    expect(at('chain.broadcast')).toBeGreaterThan(at('wallet.signPsbt'));

    // K_e is gone from memory; recovery is on disk, holds K_e (ADR-0005) and matches what the service stored.
    expect(vault.get(order.id)).toBeNull();
    const saved = loadRecovery(store)!;
    expect(saved.version).toBe(2);
    expect(saved.orderId).toBe(order.id);
    expect(saved.commitTxid).toBe(prepared.funding.txid);
    expect(saved.orderToken).toBe(vault.token(order.id));
    expect(saved.revealPrivkey).toMatch(/^[0-9a-f]{64}$/);
    expect(hex.encode(schnorr.getPublicKey(hex.decode(saved.revealPrivkey)))).toBe(order.revealPubkey);
    expect(saved.revealPubkey).toBe(order.revealPubkey);
    expect(base64ToBytes(saved.contentBase64)).toEqual(state.artwork!.bytes);
    expect(saved).toMatchObject({
      collectionAddress: state.config!.collectionAddress,
      parentValueSats: state.config!.parentValueSats,
      postageSats: order.quote!.postageSats,
      parentInscriptionId: state.config!.parentInscriptionId,
    });

    expect(services.apiOrders.get(order.id)!.commitOutpoint).toEqual({ txid: prepared.funding.txid, vout: 0 });
    expect(prepared.order.status).toBe('awaiting_payment');
    expect(txid).toBe(prepared.funding.txid);
  });

  it('never calls the wallet if submitting the reveal fails', async () => {
    const { log, services, app, vault, state, store } = await setup();
    services.mintApi.submitReveal = async () => {
      log.push('api.submitReveal');
      throw new Error('503 service unavailable');
    };
    await expect(
      preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! }),
    ).rejects.toThrow(/503/);
    expect(log).not.toContain('wallet.signPsbt');
    expect(loadRecovery(store)).toBeNull();
    // Key kept so the user can retry.
    expect(vault.get(state.order!.id)).not.toBeNull();
  });

  it('refuses to broadcast a funding tx the wallet altered', async () => {
    const { log, services, app, vault, state, store } = await setup({ wallet: { tamper: true } });
    const prepared = await preparePayment(
      { services, vault, app, store },
      { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! },
    );
    await expect(signAndBroadcast({ services }, { wallet: state.wallet!, funding: prepared.funding })).rejects.toBeInstanceOf(
      FundingTxidMismatchError,
    );
    expect(log).not.toContain('chain.broadcast');
  });

  it('uses the wallet relay when it offers pushTx', async () => {
    const { log, services, app, vault, state, store } = await setup({ wallet: { withPushTx: true } });
    const prepared = await preparePayment(
      { services, vault, app, store },
      { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! },
    );
    await signAndBroadcast({ services }, { wallet: state.wallet!, funding: prepared.funding });
    expect(log).toContain('wallet.pushTx');
    expect(log).not.toContain('chain.broadcast');
  });

  it('fails clearly if K_e is gone (reload) — before touching the network', async () => {
    const { log, services, app, vault, state, store } = await setup();
    vault.discard(state.order!.id);
    log.length = 0;
    await expect(
      preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! }),
    ).rejects.toBeInstanceOf(MissingKeyError);
    expect(log.filter((l) => l.startsWith('api.') || l.startsWith('chain.'))).toEqual([]);
  });
});

describe('0x81 reveal shape (ADR-0005 §1)', () => {
  it('signs [parent return = collection address + parentValueSats, child] up front', async () => {
    const { services, app, vault, state, store } = await setup();
    let submitted: { halfSignedRevealPsbt: string } | null = null;
    const real = services.mintApi.submitReveal;
    services.mintApi.submitReveal = async (id, token, req) => {
      submitted = req;
      return real(id, token, req);
    };
    await preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! });
    const payload = JSON.parse(atob(submitted!.halfSignedRevealPsbt));
    expect(payload.sighash).toBe('0x81');
    expect(payload.outputs).toEqual([
      { address: state.config!.collectionAddress, value: String(state.config!.parentValueSats) },
      { address: state.wallet!.ordinals.address, value: String(state.order!.quote!.postageSats) },
    ]);
  });

  it('refuses to build a reveal when the service config lacks the parent facts', async () => {
    const { log, services, app, vault, state, store } = await setup();
    const config = { ...state.config!, parentValueSats: 0 };
    await expect(
      preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config }),
    ).rejects.toThrow(/parent value/);
    expect(log).not.toContain('api.submitReveal');
    expect(vault.get(state.order!.id)).not.toBeNull();
  });
});

describe('order token', () => {
  it('is kept in memory from createOrder and sent on upload', async () => {
    const services = fakes();
    const vault = createKeyVault();
    const { state } = await stateAtQuote(services, testApp(), vault);
    const id = state.order!.id;
    expect(vault.token(id)).toMatch(/^[0-9a-f]{64}$/);
    // Not in the order object or the flow state (it only joins state inside the recovery bundle, at Pay).
    expect(JSON.stringify(state)).not.toContain(vault.token(id)!);
  });

  it('a missing token surfaces a clear error before the reveal is sent', async () => {
    const { log, services, app, state, store } = await setup();
    const fresh = createKeyVault();
    fresh.put(state.order!.id, new Uint8Array(32).fill(7)); // key present, token absent
    await expect(
      preparePayment({ services, vault: fresh, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! }),
    ).rejects.toBeInstanceOf(MissingTokenError);
    expect(new MissingTokenError().message).toMatch(/access token/);
    expect(log).not.toContain('wallet.signPsbt');
  });

  it('a service that does not return a token stops the order at creation', async () => {
    const services = fakes();
    const real = services.mintApi.createOrder;
    services.mintApi.createOrder = async (req) => ({ ...(await real(req)), orderToken: '' });
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    const { standardArtwork } = await import('./helpers');
    const artwork = await standardArtwork(services);
    await expect(
      openOrder({ services, vault: createKeyVault(), sleep: async () => undefined }, { tier: 'standard', artwork, wallet, feeRate: 3 }),
    ).rejects.toBeInstanceOf(MissingTokenError);
  });

  it('the fake service rejects mutating calls without the right token', async () => {
    const services = fakes();
    const { state } = await stateAtQuote(services, testApp());
    await expect(services.mintApi.getRescue(state.order!.id, '')).rejects.toThrow(/missing order token/);
    await expect(services.mintApi.getRescue(state.order!.id, 'nope')).rejects.toThrow(/does not match/);
  });
});

describe('commit verification', () => {
  it('matches when the service quotes the address the browser derives', async () => {
    const services = fakes();
    const app = testApp();
    const { state } = await stateAtQuote(services, app);
    const r = verifyCommit(services, { order: state.order!, artwork: state.artwork!, config: state.config!, network: app.network });
    expect(r.match).toBe(true);
    expect(r.localAddress).toBe(state.order!.quote!.commitAddress);
  });

  it('flags a tampered commit address and an indicative (non-binding) quote', async () => {
    const services = fakes({ mint: { tamperCommit: true } });
    const app = testApp();
    const { state } = await stateAtQuote(services, app);
    expect(verifyCommit(services, { order: state.order!, artwork: state.artwork!, config: state.config!, network: 'mainnet' }).match).toBe(false);
    const indicative = { ...state.order!, quote: { ...state.order!.quote!, binding: false } };
    expect(verifyCommit(services, { order: indicative, artwork: state.artwork!, config: state.config!, network: 'mainnet' }).match).toBe(false);
  });
});

describe('rescue (ADR-0005 §2: re-signed locally with K_e from the bundle)', () => {
  async function toRescueAvailable(opts: Parameters<typeof setup>[0] = {}) {
    const t = await setup({ ...opts, mint: { scenario: 'rescue', ...(opts.mint ?? {}) } });
    const p = await preparePayment({ services: t.services, vault: t.vault, app: t.app, store: t.store }, { order: t.state.order!, artwork: t.state.artwork!, wallet: t.state.wallet!, config: t.state.config! });
    // The fake service walks paid -> queued -> rescue_available on polls.
    let o = await t.services.mintApi.getOrder(t.state.order!.id);
    for (let i = 0; i < 5 && o.status !== 'rescue_available'; i++) o = await t.services.mintApi.getOrder(o.id);
    expect(o.status).toBe('rescue_available');
    t.log.length = 0;
    return { ...t, bundle: p.bundle };
  }

  it('fetches the inputs from the service, checks them against the bundle, re-signs with K_e and broadcasts', async () => {
    const { log, services, state, bundle } = await toRescueAvailable();
    const r = await rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle, wallet: null, network: 'mainnet' });
    expect(r.source).toBe('service');
    expect(log.indexOf('api.getRescue')).toBeLessThan(log.indexOf('inscription.buildResignedRescue'));
    expect(log.indexOf('inscription.buildResignedRescue')).toBeLessThan(log.indexOf('chain.broadcast'));
    expect(r.tx.fee).toBe(BigInt(bundle.commitValueSats - bundle.postageSats));
    expect(r.txid).toBe(r.tx.txid);
  });

  it('works from the bundle alone when the service is gone', async () => {
    const { log, services, state, bundle } = await toRescueAvailable({ mint: { rescueEndpointDown: true } });
    const r = await rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle, wallet: null, network: 'mainnet' });
    expect(r.source).toBe('local');
    expect(log).toContain('inscription.buildResignedRescue');
    expect(log).toContain('chain.broadcast');
  });

  it('uses the wallet relay when it offers pushTx', async () => {
    const { log, services, state, bundle } = await toRescueAvailable({ wallet: { withPushTx: true } });
    await rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle, wallet: state.wallet, network: 'mainnet' });
    expect(log).toContain('wallet.pushTx');
    expect(log).not.toContain('chain.broadcast');
  });

  it('refuses to sign when the service inputs disagree with the bundle', async () => {
    const { log, services, state, bundle } = await toRescueAvailable();
    const tampered = { ...bundle, recipientAddress: 'bc1pattacker' };
    await expect(rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle: tampered, wallet: null, network: 'mainnet' })).rejects.toBeInstanceOf(RescueInputsMismatchError);
    expect(log).not.toContain('inscription.buildResignedRescue');
    expect(log).not.toContain('chain.broadcast');
  });

  it('refuses when the bundle content bytes do not hash to the order content', async () => {
    const { services, state, bundle } = await toRescueAvailable();
    const bad = { ...bundle, contentBase64: 'AAAA' };
    await expect(rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle: bad, wallet: null, network: 'mainnet' })).rejects.toThrow(/content bytes/);
  });

  it('is not offered before rescue_available (409 from the service is a real answer, not "service gone")', async () => {
    const { log, services, app, vault, state, store } = await setup();
    const p = await preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! });
    await expect(rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle: p.bundle, wallet: null, network: 'mainnet' })).rejects.toThrow(/409/);
    expect(log).not.toContain('inscription.buildResignedRescue');
  });

  it('without a bundle there is no key, so there is no rescue', async () => {
    const services = fakes();
    await expect(
      rescue({ services }, { orderId: 'x', orderToken: 'tok', bundle: null, wallet: null, network: 'mainnet' }),
    ).rejects.toBeInstanceOf(MissingBundleError);
  });
});
