/**
 * DGT-SEC-006: the browser signs and pays only for what it derived itself. A hostile or compromised mint
 * API (or anything between the page and it) must not be able to make the page fund a commit locked to
 * someone else's key, pre-sign a child to someone else's address, or pay a commit address the page did not
 * compute, even after the order passed the Quote step's commit check.
 */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import type { Order } from '@bsh/degent-mint-sdk';
import { createKeyVault } from '../src/flow/keyVault';
import { QuoteMismatchError, preparePayment, verifyCommit } from '../src/flow/effects';
import { fakeAddress } from '../src/services/fakes';
import { loadRecovery } from '../src/lib/recovery';
import { fakes, memoryStore, stateAtQuote, testApp } from './helpers';

const PASS = 'correct horse battery staple';

async function setup() {
  const log: string[] = [];
  const services = fakes({ log });
  const app = testApp();
  const vault = createKeyVault();
  const { state } = await stateAtQuote(services, app, vault);
  const store = memoryStore(log);
  return { log, services, app, vault, state, store };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function payWith(t: Setup, order: Order) {
  t.log.length = 0;
  return preparePayment(
    { services: t.services, vault: t.vault, app: t.app, store: t.store },
    { order, artwork: t.state.artwork!, wallet: t.state.wallet!, config: t.state.config!, passphrase: PASS },
  );
}

function expectNothingSent(t: Setup) {
  expect(t.log).not.toContain('api.submitReveal');
  expect(t.log).not.toContain('inscription.buildHalfSignedReveal');
  expect(t.log).not.toContain('wallet.signPsbt');
  expect(loadRecovery(t.store)).toBeNull();
}

describe('DGT-SEC-006: preparePayment re-derives what it signs and pays', () => {
  it('refuses an order whose reveal key is not the one this browser generated (commit address consistent with it)', async () => {
    const t = await setup();
    const order = t.state.order!;
    const attacker = hex.encode(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
    const content = { contentType: t.state.artwork!.contentType, body: t.state.artwork!.bytes, ...(t.state.config!.parentInscriptionId ? { parentId: t.state.config!.parentInscriptionId } : {}) };
    const forged: Order = {
      ...order,
      revealPubkey: attacker,
      quote: { ...order.quote!, commitAddress: t.services.inscription.commitAddress(attacker, content, t.app.network) },
    };
    // The Quote step's check now also derives the key from this browser's vault.
    expect(verifyCommit(t.services, { order: forged, artwork: t.state.artwork!, config: t.state.config!, network: t.app.network, vault: t.vault }).match).toBe(false);
    await expect(payWith(t, forged)).rejects.toBeInstanceOf(QuoteMismatchError);
    expectNothingSent(t);
    expect(t.vault.get(order.id)).not.toBeNull();
  });

  it('refuses a commit address it did not compute', async () => {
    const t = await setup();
    const order = t.state.order!;
    const forged: Order = { ...order, quote: { ...order.quote!, commitAddress: fakeAddress('attacker-commit', t.app.network) } };
    await expect(payWith(t, forged)).rejects.toBeInstanceOf(QuoteMismatchError);
    expectNothingSent(t);
  });

  it("refuses to pre-sign a child to an address other than the wallet's ordinals address", async () => {
    const t = await setup();
    const order = t.state.order!;
    const forged: Order = { ...order, recipientAddress: fakeAddress('attacker-ordinals', t.app.network) };
    await expect(payWith(t, forged)).rejects.toBeInstanceOf(QuoteMismatchError);
    expectNothingSent(t);
  });

  it('refuses a parent return address other than the collection address the mint published', async () => {
    const t = await setup();
    const order = t.state.order!;
    const forged: Order = { ...order, quote: { ...order.quote!, parentReturnAddress: fakeAddress('attacker-parent', t.app.network) } };
    await expect(payWith(t, forged)).rejects.toBeInstanceOf(QuoteMismatchError);
    expectNothingSent(t);
  });

  it('refuses an order for other bytes than the artwork on screen', async () => {
    const t = await setup();
    const order = t.state.order!;
    await expect(payWith(t, { ...order, contentSha256: 'ab'.repeat(32) })).rejects.toBeInstanceOf(QuoteMismatchError);
    expectNothingSent(t);
  });

  it('an honest order still pays', async () => {
    const t = await setup();
    const prepared = await payWith(t, t.state.order!);
    expect(prepared.order.status).toBe('awaiting_payment');
    expect(t.log).toContain('api.submitReveal');
  });
});
