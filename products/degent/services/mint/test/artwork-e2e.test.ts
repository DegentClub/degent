/**
 * End to end for an Open Studio artwork order (plan §3.8): artwork -> order (approved) -> 0x81 half-signed
 * reveal with attribution metadata -> funding tx [commit, royalty, club, change] -> reveal with parent ->
 * delivered, with the studio fake receiving the royalty record, collection.minted published with the artist
 * fields, and the ledger holding the payouts. Then: a rescue after an outage leaves royaltyPaid intact.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { addressToScript, decodeAttribution, inscriptionIdFromReveal } from '@bsh/inscription';
import type { Order } from '@bsh/degent-mint-sdk';
import { api, browserArtworkToPayment, browserRescue, fundArtwork, makeHarness, NET, regtestAddress, studioArtwork, type Harness } from './fakes/harness.js';

const CLUB = regtestAddress(5);
const artHarness = () => makeHarness({ settings: { serviceFeeAddress: CLUB } });
const getOrder = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

/** ord tag 5 metadata chunks of the envelope, concatenated (tag 5 = push 0x05, then a data push). */
function metadataOf(leafScript: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let i = 0;
  const readPush = (): Uint8Array | null => {
    const op = leafScript[i++]!;
    let n: number;
    if (op === 0) return new Uint8Array();
    if (op <= 75) n = op;
    else if (op === 0x4c) n = leafScript[i++]!;
    else if (op === 0x4d) {
      n = leafScript[i]! | (leafScript[i + 1]! << 8);
      i += 2;
    } else return null;
    const out = leafScript.subarray(i, i + n);
    i += n;
    return out;
  };
  // skip <pubkey> OP_CHECKSIG OP_0 OP_IF "ord"
  i = 0;
  readPush(); // pubkey
  i += 3; // OP_CHECKSIG OP_0 OP_IF
  readPush(); // "ord"
  while (i < leafScript.length && leafScript[i] !== 0x68) {
    if (leafScript[i] === 0x00) {
      i++; // OP_0: body follows
      while (i < leafScript.length && leafScript[i] !== 0x68) readPush();
      break;
    }
    const tag = readPush();
    const data = readPush();
    if (tag && data && tag.length === 1 && tag[0] === 5) chunks.push(data);
  }
  return new Uint8Array(chunks.flatMap((c) => [...c]));
}

describe('e2e: artwork order with royalty', () => {
  it('artwork -> approved order -> reveal with attribution -> fund [commit, royalty, club] -> delivered; studio, ledger and collection.minted all see it', async () => {
    const h = artHarness();
    const art = studioArtwork(h, { artistSeed: 7 });
    const b = await browserArtworkToPayment(h, art.id);
    expect(b.order.status).toBe('awaiting_payment');
    const q = b.order.quote!;

    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('awaiting_payment');

    fundArtwork(h, b);
    const rep = await h.worker.tick();
    expect(rep.errors).toEqual([]);
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued', 'revealing', 'revealed']);

    // The reveal: same layout as any Degent, weight == quote, and the leaf script carries the attribution.
    expect(h.broadcasters.standard.sent).toHaveLength(1);
    const tx = Transaction.fromRaw(hex.decode(h.broadcasters.standard.sent[0]!), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
    const weight = tx.toBytes(true, false).length * 3 + tx.toBytes(true, true).length;
    expect(weight).toBe(q.revealWeight);
    expect(tx.inputsLength).toBe(2);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(0).amount).toBe(h.parentValue);
    expect(bytesToHex(tx.getOutput(1).script!)).toBe(bytesToHex(addressToScript(b.recipientAddress, NET)));
    const witness = tx.getInput(1).finalScriptWitness!;
    expect(witness[0]![64]).toBe(0x81);
    const leaf = witness[1]!;
    expect(decodeAttribution(metadataOf(leaf))).toEqual({ artist: art.payoutAddress, artwork: art.id, edition: 1, studio: 'degent.club' });

    let o = await getOrder(h, b.orderId);
    expect(o).toMatchObject({ status: 'revealed', edition: 1, royaltyPaid: { txid: b.commitTxid, vout: 1, sats: q.artistRoyaltySats }, artworkId: art.id, artistAddress: art.payoutAddress });
    expect(o.inscriptionId).toBe(inscriptionIdFromReveal(tx.id, 0));

    h.chain.mine();
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('confirmed');
    h.chain.inscriptions.set(o.inscriptionId!, b.bytes);
    await h.worker.tick();
    o = await getOrder(h, b.orderId);
    expect(o.status).toBe('delivered');
    expect(o.timeline.map((e) => e.status)).toEqual([
      'awaiting_content', 'reviewing', 'approved', 'awaiting_payment', 'paid', 'queued', 'revealing', 'revealed', 'confirmed', 'verified', 'delivered',
    ]);

    // Studio: the royalty record, once.
    expect(h.studio!.royalties).toEqual([{ orderId: b.orderId, artworkId: art.id, minterAddress: b.recipientAddress, royaltySats: q.artistRoyaltySats, fundingTxid: b.commitTxid, vout: 1, at: expect.any(String), edition: 1 }]);
    // Events: royalty.paid once, collection.minted once with the Open Studio fields (platform topic 1.1.0).
    expect(h.events.royaltyEvents.map((e) => e.orderId)).toEqual([b.orderId]);
    const minted = h.events.mintedEvents;
    expect(minted).toHaveLength(1);
    expect(minted[0]).toEqual({
      type: 'collection.minted',
      collectionId: 'degent',
      network: 'regtest',
      inscriptionId: o.inscriptionId,
      parentInscriptionId: h.settings.collection.parentInscriptionId,
      txid: o.revealTxid,
      orderId: b.orderId,
      contentHash: art.contentSha256,
      mintedAt: o.updatedAt,
      artist: art.payoutAddress,
      artworkId: art.id,
      edition: 1,
      royalty: { txid: b.commitTxid, vout: 1, sats: q.artistRoyaltySats },
    });
    // Ledger: order, intent, paid with payouts for the commit, the club and the artist.
    const lo = h.ledger!.orders[0]!;
    expect(lo.payments[0]!.status).toBe('paid');
    expect(lo.payments[0]!.payouts.map((p) => p.payee.kind).sort()).toEqual(['artist', 'club', 'platform']);
    expect(lo.payments[0]!.payouts.find((p) => p.payee.kind === 'artist')).toMatchObject({ amountSats: q.artistRoyaltySats, txid: b.commitTxid, vout: 1 });
    // No secrets in events.
    expect(JSON.stringify(h.events.events)).not.toContain(b.psbt!.slice(0, 40));
  });

  it('two artists, three mints: each artist is paid to their own script and editions count per artwork', async () => {
    const h = artHarness();
    const a = studioArtwork(h, { artistSeed: 1 });
    const c = studioArtwork(h, { artistSeed: 2, bytes: (await import('./fakes/harness.js')).standardArt(200_000, 1000, 1000) });
    const m1 = await browserArtworkToPayment(h, a.id, { recipientSeed: 1 });
    const m2 = await browserArtworkToPayment(h, c.id, { recipientSeed: 2 });
    const m3 = await browserArtworkToPayment(h, a.id, { recipientSeed: 3 });
    for (const m of [m1, m2, m3]) fundArtwork(h, m);
    await h.worker.tick();
    expect((await getOrder(h, m1.orderId)).edition).toBe(1);
    expect((await getOrder(h, m2.orderId)).edition).toBe(1);
    expect((await getOrder(h, m3.orderId)).edition).toBe(2);
    expect(h.studio!.royalties.map((r) => r.artworkId)).toEqual([a.id, c.id, a.id]);
    expect(h.events.royaltyEvents.map((e) => e.artist)).toEqual([a.payoutAddress, c.payoutAddress, a.payoutAddress]);
  });
});

describe('e2e: rescue after an outage leaves the artist paid (plan §3.8)', () => {
  it('lane down 6 h -> rescue_available -> re-signed rescue with the attribution -> delivered; royaltyPaid intact, studio record kept, no collection.minted', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { confirmed: true });
    h.broadcasters.standard.mode = 'retryable';
    await h.worker.tick();
    let o = await getOrder(h, b.orderId);
    expect(o.status).toBe('revealing');
    expect(o.royaltyPaid).toMatchObject({ vout: 1 });
    expect(h.studio!.royalties).toHaveLength(1); // the artist was paid when the minter paid (ADR-0007 §5)

    h.clock.advance(6 * 3600 + 1);
    await h.worker.tick();
    o = await getOrder(h, b.orderId);
    expect(o.status).toBe('rescue_available');
    expect(o.royaltyPaid).toEqual({ txid: b.commitTxid, vout: 1, sats: b.order.quote!.artistRoyaltySats });
    expect(o.edition).toBe(1);

    // The rescue reproduces the same envelope (attribution from the bundle == rescue inputs) and lands.
    const { inputs, rescue } = await browserRescue(h, b);
    expect(inputs).toMatchObject({ artworkId: art.id, artistAddress: art.payoutAddress, edition: 1 });
    expect(rescue.weight).toBe(inputs.rescueWeight);
    await h.worker.tick();
    o = await getOrder(h, b.orderId);
    expect(o).toMatchObject({ status: 'revealed', rescued: true, revealTxid: rescue.txid });
    h.chain.mine();
    h.chain.inscriptions.set(`${rescue.txid}i0`, b.bytes);
    await h.worker.tick();
    await h.worker.tick();
    o = await getOrder(h, b.orderId);
    expect(o.status).toBe('delivered');
    expect(o.rescued).toBe(true);
    // The artist stays paid: the royalty lives in the funding transaction, not in the reveal.
    expect(o.royaltyPaid).toEqual({ txid: b.commitTxid, vout: 1, sats: b.order.quote!.artistRoyaltySats });
    expect(o.edition).toBe(1);
    expect(h.studio!.royalties).toHaveLength(1);
    expect(h.studio!.postCalls).toBe(1);
    expect(h.events.royaltyEvents).toHaveLength(1);
    // No parent link: not a collection mint.
    expect(h.events.mintedEvents).toHaveLength(0);
  });

  it('a policy refusal on an artwork order offers rescue with royaltyPaid intact', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    h.settings.policy.bands.standard.maxFeeRate = 1.5;
    const rep = await h.worker.tick();
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued', 'revealing', 'rescue_available']);
    const o = await getOrder(h, b.orderId);
    expect(o.royaltyPaid).toMatchObject({ vout: 1 });
    expect(h.studio!.royalties).toHaveLength(1);
  });
});
