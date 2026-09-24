/**
 * ADR-0005: SIGHASH_ALL|ANYONECANPAY (0x81) half-signed reveals and the re-signed self-rescue.
 *
 * - the binding quote exposes the parent return address and value the browser signs as output 0;
 * - POST /reveal accepts only 0x81 over [parent return, child] with exactly those values (0x83 is refused);
 * - GET /rescue returns parameters, never a transaction; the browser re-signs [commit] -> [child] with K_e and the
 *   signature verifies over the BIP341 digest computed by @bsh/inscription (one implementation of the maths);
 * - declined and rescue_available both use it; a parent whose value changed hands the order to self-rescue.
 */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { addressToScript, buildHalfSignedReveal, commitAddress, revealCommitSighash, sha256Hex } from '@bsh/inscription';
import type { Order, RescueResponse } from '@bsh/degent-mint-sdk';
import {
  api,
  browserCreate,
  browserMintToPayment,
  browserRescue,
  browserUpload,
  castVote,
  fakeTxid,
  fundAndApprove,
  fundToReview,
  makeHarness,
  NET,
  regtestAddress,
  type BrowserMint,
  type Harness,
} from './fakes/harness.js';

const getOrder = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

/** Submit a reveal built with non-default options (what a stale or hostile client might send). */
async function submitWith(h: Harness, b: BrowserMint, opts: Partial<Parameters<typeof buildHalfSignedReveal>[0]>) {
  const quote = b.order.quote!;
  const content = { contentType: b.contentType, body: b.bytes, parentId: h.settings.collection.parentInscriptionId! };
  const commitTxid = fakeTxid(4242);
  const { psbtBase64 } = buildHalfSignedReveal({
    network: NET,
    revealPrivkey: b.revealKey,
    content,
    commitOutpoint: { txid: commitTxid, vout: 0 },
    commitValue: BigInt(quote.commitValueSats),
    recipientAddress: b.recipientAddress,
    postage: BigInt(quote.postageSats),
    parentReturnAddress: quote.parentReturnAddress,
    parentValue: BigInt(quote.parentValueSats!),
    ...opts,
  });
  return api(h, 'POST', `/v1/orders/${b.orderId}/reveal`, {
    json: { commitTxid, commitVout: 0, halfSignedRevealPsbt: psbtBase64 },
    token: b.token,
  });
}

async function approvedOrder(h: Harness): Promise<BrowserMint> {
  await h.ready;
  const b = await browserCreate(h);
  await browserUpload(h, b);
  return b;
}

describe('0x81 half-signed reveals (ADR-0005)', () => {
  it('the binding quote carries the parent return address and the current parent value', async () => {
    const h = makeHarness({ parentValue: 7_777n });
    const b = await approvedOrder(h);
    expect(b.order.quote).toMatchObject({
      binding: true,
      parentReturnAddress: h.signer.collectionAddress(),
      parentValueSats: 7_777,
    });
  });

  it('accepts 0x81 over [parent return, child] and stores it', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    expect(b.order.status).toBe('awaiting_payment');
    const tx = Transaction.fromPSBT(Buffer.from(b.psbt!, 'base64'));
    expect(tx.outputsLength).toBe(2);
    expect(hex.encode(tx.getOutput(0).script!)).toBe(h.collectionScriptHex);
    expect(tx.getOutput(0).amount).toBe(h.parentValue);
    expect(tx.getInput(0).tapScriptSig![0]![1][64]).toBe(0x81);
  });

  it.each<[string, Partial<Parameters<typeof buildHalfSignedReveal>[0]>, RegExp]>([
    ['a legacy 0x83 reveal', { sighash: 'single_anyonecanpay' }, /output|sighash|hash type/i],
    ['another parent value', { parentValue: 9_999n }, /parent/i],
    ['another parent return address', { parentReturnAddress: regtestAddress(9) }, /parent/i],
    ['no parent return output', { withParent: false }, /output/i],
  ])('refuses %s', async (_n, opts, re) => {
    const h = makeHarness();
    const b = await approvedOrder(h);
    const r = await submitWith(h, b, opts);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('reveal_invalid');
    expect(r.body.error.message).toMatch(re);
    expect((await getOrder(h, b.orderId)).status).toBe('approved');
  });

  it('refuses the upload (503, before review) while the parent UTXO is unknown', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    await h.store.setMeta('parent_utxo', JSON.stringify({ utxo: null, leasedBy: null }));
    const r = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes, token: b.token });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('upstream_unavailable');
    expect((await getOrder(h, b.orderId)).status).toBe('awaiting_content');
  });
});

describe('re-signed self-rescue (ADR-0005)', () => {
  it('GET /rescue returns parameters only; the K_e re-signed rescue verifies and lands without the parent', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    await fundToReview(h, b);
    for (const seed of [101, 102, 103]) expect((await castVote(h, seed, b.orderId, 'decline')).status).toBe(200);
    expect((await getOrder(h, b.orderId)).status).toBe('declined');

    expect((await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`)).status).toBe(401);
    const raw = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
    const params = raw.body as RescueResponse;
    expect(Object.keys(params).sort()).toEqual(
      ['commitOutpoint', 'commitValueSats', 'contentBase64', 'contentSha256', 'contentType', 'feeRate', 'feeSats', 'method', 'network',
        'orderId', 'parentInscriptionId', 'postageSats', 'recipientAddress', 'revealPubkey', 'vsize', 'weight'].sort(),
    );
    expect(sha256Hex(new Uint8Array(Buffer.from(params.contentBase64, 'base64')))).toBe(b.order.contentSha256);
    expect(params.parentInscriptionId).toBe(h.settings.collection.parentInscriptionId);

    const { tx: rescue } = await browserRescue(h, b);
    expect(rescue.weight).toBe(params.weight);
    // The rescue is lighter than the quoted parent reveal, so it pays at least the quoted rate.
    expect(params.weight).toBeLessThan(b.order.quote!.revealWeight);
    expect(Number(rescue.fee) / rescue.vsize).toBeGreaterThanOrEqual(params.feeRate);

    // SIGHASH_DEFAULT signature by K_e over the BIP341 digest of [commit] -> [child], digest from @bsh/inscription.
    const tx = Transaction.fromRaw(hex.decode(rescue.hex), { allowUnknownOutputs: true, disableScriptCheck: true });
    expect([tx.inputsLength, tx.outputsLength]).toEqual([1, 1]);
    const witness = tx.getInput(0).finalScriptWitness!;
    expect(witness[0]).toHaveLength(64);
    const content = { contentType: b.contentType, body: b.bytes, parentId: params.parentInscriptionId! };
    const commit = commitAddress(schnorr.getPublicKey(b.revealKey), content, NET);
    const digest = revealCommitSighash({
      commitOutpoint: params.commitOutpoint,
      commitValue: BigInt(params.commitValueSats),
      commitScript: commit.script,
      tapLeafHash: commit.tapLeafHash,
      outputs: [{ script: addressToScript(b.recipientAddress, NET), value: BigInt(params.postageSats) }],
      sighashType: 0,
    });
    expect(schnorr.verify(witness[0]!, digest, schnorr.getPublicKey(b.revealKey))).toBe(true);

    h.chain.acceptRaw(rescue.hex);
    await h.worker.tick();
    expect(await getOrder(h, b.orderId)).toMatchObject({ status: 'revealed', rescued: true, revealTxid: rescue.txid });
  });

  it('a parent whose value changed after signing hands the order to self-rescue (no retry loop)', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    await fundAndApprove(h, b);
    // Operator re-initialises the parent with another value while the order waits in the lane.
    const cur = (await h.parents.current())!;
    await h.parents.initialise({ ...cur, value: cur.value + 1n }, { force: true });
    const rep = await h.worker.tick();
    expect(rep.transitions.map((t) => t.to)).toEqual(['revealing', 'rescue_available']);
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    expect(await h.parents.leasedBy()).toBeNull();
    const o = await getOrder(h, b.orderId);
    expect(o.timeline.at(-1)!.detail).toMatch(/parent UTXO value .* differs/);
    const { tx } = await browserRescue(h, b);
    h.chain.acceptRaw(tx.hex);
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('revealed');
  });
});
