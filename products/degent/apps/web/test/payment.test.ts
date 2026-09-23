import { describe, expect, it } from 'vitest';
import { createKeyVault, type KeyVault } from '../src/flow/keyVault';
import {
  FundingTxidMismatchError,
  MissingKeyError,
  MissingTokenError,
  openOrder,
  preparePayment,
  rescue,
  signAndBroadcast,
  verifyCommit,
} from '../src/flow/effects';
import { loadRecovery } from '../src/lib/recovery';
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

    // K_e is gone; recovery is on disk and matches what the service stored.
    expect(vault.get(order.id)).toBeNull();
    const saved = loadRecovery(store)!;
    expect(saved.orderId).toBe(order.id);
    expect(saved.commitTxid).toBe(prepared.funding.txid);
    expect(saved.orderToken).toBe(vault.token(order.id));
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

describe('rescue', () => {
  it('uses the service rescue tx with the order token when available', async () => {
    const { log, services, app, vault, state, store } = await setup();
    const p = await preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! });
    const r = await rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle: p.bundle, wallet: null, network: 'mainnet' });
    expect(r.source).toBe('service');
    expect(log).toContain('api.getRescue');
    expect(log).toContain('chain.broadcast');
    expect(log).not.toContain('inscription.buildRescueReveal');
  });

  it('builds the rescue locally from the bundle when the service is gone', async () => {
    const { log, services, app, vault, state, store } = await setup({ mint: { rescueEndpointDown: true } });
    const p = await preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! });
    const r = await rescue({ services }, { orderId: state.order!.id, orderToken: null, bundle: p.bundle, wallet: null, network: 'mainnet' });
    expect(r.source).toBe('local');
    expect(log.indexOf('inscription.buildRescueReveal')).toBeLessThan(log.lastIndexOf('chain.broadcast'));
  });

  it('without a bundle or token, explains that the token is missing', async () => {
    const services = fakes();
    await expect(
      rescue({ services }, { orderId: 'x', orderToken: null, bundle: null, wallet: null, network: 'mainnet' }),
    ).rejects.toBeInstanceOf(MissingTokenError);
  });
});
