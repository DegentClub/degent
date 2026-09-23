/**
 * End-to-end on a fake regtest chain: browser-built half-signed reveal -> service -> worker ticks
 * through attach-parent, policy signing, broadcast, confirmation, ord verification, delivery.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { addressToScript, inscriptionIdFromReveal } from '@bsh/inscription';
import type { Order, RescueResponse } from '@bsh/degent-mint-sdk';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { api, browserCreate, browserMintToPayment, browserReveal, browserUpload, fundCommit, makeHarness, NET, standardArt } from './fakes/harness.js';
import { png } from './fakes/images.js';

function parseRaw(rawHex: string) {
  const tx = Transaction.fromRaw(hex.decode(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  const full = tx.toBytes(true, true);
  const stripped = tx.toBytes(true, false);
  return { tx, weight: stripped.length * 3 + full.length };
}

async function getOrder(h: ReturnType<typeof makeHarness>, id: string): Promise<Order> {
  return (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;
}

describe('e2e: parent-linked mint', () => {
  it.each([
    ['standard', 200_000],
    ['block', 400_000],
  ] as const)('%s Degent: order -> upload -> half-signed reveal -> fund -> reveal with parent -> delivered', async (tier, size) => {
    const h = makeHarness();
    const art = png(1500, 1500, size);
    const b = await browserMintToPayment(h, { bytes: art, tier });
    expect(b.order.status).toBe('awaiting_payment');
    expect(b.order.quote!.binding).toBe(true);
    expect(b.order.quote!.lane).toBe(tier);

    // Unfunded: nothing happens.
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('awaiting_payment');

    fundCommit(h, b);
    const rep = await h.worker.tick();
    expect(rep.errors).toEqual([]);
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued', 'revealing', 'revealed']);

    // Broadcaster captured exactly one tx on the right lane; it parses, and weight == quote.
    const lane = h.broadcasters[tier];
    expect(lane.sent).toHaveLength(1);
    const { tx, weight } = parseRaw(lane.sent[0]!);
    expect(weight).toBe(b.order.quote!.revealWeight);
    expect(tx.inputsLength).toBe(2);
    expect(tx.outputsLength).toBe(2);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(h.parentTxid);
    expect(hex.encode(tx.getInput(1).txid!)).toBe(b.commitTxid);
    expect(tx.getOutput(0).amount).toBe(h.parentValue);
    expect(bytesToHex(tx.getOutput(0).script!)).toBe(h.collectionScriptHex);
    expect(tx.getOutput(1).amount).toBe(546n);
    expect(bytesToHex(tx.getOutput(1).script!)).toBe(bytesToHex(addressToScript(b.recipientAddress, NET)));
    // fee = commit value - postage, exactly as quoted
    expect(BigInt(b.order.quote!.commitValueSats) - 546n).toBe(BigInt(b.order.quote!.revealFeeSats));

    let o = await getOrder(h, b.orderId);
    expect(o.status).toBe('revealed');
    expect(o.revealTxid).toBe(tx.id);
    expect(o.inscriptionId).toBe(inscriptionIdFromReveal(tx.id, 0));
    // Parent chained: new parent UTXO is output 0 of this reveal.
    expect(await h.parents.current()).toMatchObject({ txid: tx.id, vout: 0, value: h.parentValue, confirmed: false });

    // Confirm, then ord indexes the same bytes.
    h.chain.mine();
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('confirmed');
    expect((await h.parents.current())!.confirmed).toBe(true);
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('confirmed'); // ord not indexed yet
    h.chain.inscriptions.set(o.inscriptionId!, art);
    await h.worker.tick();
    o = await getOrder(h, b.orderId);
    expect(o.status).toBe('delivered');
    expect(o.rescued).toBe(false);
    expect(o.timeline.map((e) => e.status)).toEqual([
      'awaiting_content', 'reviewing', 'approved', 'awaiting_payment', 'paid', 'queued', 'revealing', 'revealed', 'confirmed', 'verified', 'delivered',
    ]);
    // Every transition was emitted as an event, none carrying the PSBT.
    const types = h.events.events.filter((e) => e.orderId === b.orderId).map((e) => e.type);
    expect(types).toEqual(o.timeline.map((e) => `degent.mint.order.${e.status}`));
    expect(JSON.stringify(h.events.events)).not.toContain(b.psbt!.slice(0, 40));
  });

  it('chains the parent across consecutive mints', async () => {
    const h = makeHarness();
    const a = await browserMintToPayment(h, { recipientSeed: 1 });
    const b = await browserMintToPayment(h, { recipientSeed: 2 });
    fundCommit(h, a);
    fundCommit(h, b);
    await h.worker.tick();
    const [t1, t2] = h.broadcasters.standard.sent.map((x) => parseRaw(x).tx);
    expect(t1 && t2).toBeTruthy();
    // second reveal spends output 0 of the first (standard lane may chain unconfirmed)
    expect(hex.encode(t2!.getInput(0).txid!)).toBe(t1!.id);
    expect(t2!.getInput(0).index).toBe(0);
    expect((await h.parents.current())!.txid).toBe(t2!.id);
  });
});

describe('e2e: rescue path', () => {
  it('lane down for 6 h -> rescue_available -> GET /rescue -> user broadcasts -> delivered without parent', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b, { confirmed: true });
    h.broadcasters.standard.mode = 'retryable';
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('revealing');
    expect(await h.parents.leasedBy()).toBe(b.orderId);

    // rescue not yet available
    const early = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('rescue_unavailable');

    h.clock.advance(6 * 3600 + 1);
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('rescue_available');
    expect(await h.parents.leasedBy()).toBeNull(); // parent lease released, parent unchanged
    expect((await h.parents.current())!.txid).toBe(h.parentTxid);

    const res = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
    expect(res.status).toBe(200);
    const rescue = res.body as RescueResponse;
    const { tx, weight } = parseRaw(rescue.hex);
    expect(weight).toBe(rescue.weight);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(b.commitTxid);
    expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(addressToScript(b.recipientAddress, NET)));

    // The user (or anyone) broadcasts it.
    h.chain.acceptRaw(rescue.hex);
    await h.worker.tick();
    let after = await getOrder(h, b.orderId);
    expect(after).toMatchObject({ status: 'revealed', rescued: true, revealTxid: rescue.txid, inscriptionId: `${rescue.txid}i0` });
    h.chain.mine();
    h.chain.inscriptions.set(`${rescue.txid}i0`, b.bytes);
    await h.worker.tick();
    await h.worker.tick();
    after = await getOrder(h, b.orderId);
    expect(after.status).toBe('delivered');
    expect(after.rescued).toBe(true);
  });

  it('policy refusal offers self-rescue immediately', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    // Sabotage: the stored parent UTXO no longer matches what the signer expects (value drift).
    const cur = (await h.parents.current())!;
    await h.parents.initialise({ ...cur, value: cur.value + 1n }, { force: true });
    // make the fake chain agree so attachParent can build it; the policy must still refuse
    // because output 0 value != parent input value is impossible via attachParent, so instead
    // change the policy band to exclude the quoted fee rate.
    h.settings.policy.bands.standard.maxFeeRate = 1.5;
    const rep = await h.worker.tick();
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued', 'revealing', 'rescue_available']);
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    expect(await h.parents.leasedBy()).toBeNull();
    const r = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
    expect(r.status).toBe(200);
  });
});

describe('e2e: tampering is rejected', () => {
  it('upload with different bytes than declared is refused and the order stays awaiting_content', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    const tampered = Uint8Array.from(b.bytes);
    tampered[tampered.length - 100] ^= 0xff;
    const res = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: tampered, token: b.token });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('content_mismatch');
    expect(res.body.error.details).toEqual({ declared: sha256Hex(b.bytes), actual: sha256Hex(tampered) });
    expect((await getOrder(h, b.orderId)).status).toBe('awaiting_content');
  });

  it('a half-signed reveal for different content / recipient / value is refused', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    await browserUpload(h, b);
    // Browser signs a reveal whose envelope carries other bytes.
    const good = b.bytes;
    b.bytes = standardArt(200_000, 1024, 1025);
    const bad = await browserReveal(h, b).catch((e) => ({ status: 0, body: String(e) }));
    // the harness itself detects the commit address mismatch first
    expect(String(bad.body)).toContain('disagree');
    b.bytes = good;
    // Recipient swap: sign for another address.
    const other = { ...b, recipientAddress: (await import('./fakes/harness.js')).regtestAddress(77) };
    const r2 = await browserReveal(h, other);
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('reveal_invalid');
    // Honest reveal still works afterwards.
    const ok = await browserReveal(h, b);
    expect(ok.status).toBe(200);
  });

  it('ord serving different bytes marks the order failed', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    h.chain.mine();
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    h.chain.inscriptions.set(o.inscriptionId!, standardArt(200_000, 999, 999));
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('failed');
  });

  it('funding the commit with the wrong amount fails the order (never co-signed)', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b, { value: BigInt(b.order.quote!.commitValueSats) - 1n });
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('failed');
    expect(h.broadcasters.standard.sent).toHaveLength(0);
  });
});
