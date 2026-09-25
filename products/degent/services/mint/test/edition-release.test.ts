/**
 * Security review item 11 / roadmap p5.7: an edition is consumed the moment its funding tx is SEEN (0-conf,
 * plan §3.3), before any confirmation. If that mint never actually lands — the funding is short, the tx is
 * dropped/replaced before the order ever gets to `revealing`, the policy signer refuses, or a rescue timeout
 * fires — the edition must go back to the artwork's pool rather than being burned forever, UNLESS this
 * order's own reveal (parent-linked, or a self-rescue of it) already confirmed on chain: that inscription is
 * real, so the assignment is permanent and correct (`hasConfirmedReveal`, `domain/order.ts`).
 *
 * `OrderService.releaseEdition` also refuses whenever `royaltyPaid` is set (the artist WAS paid in this
 * order's funding transaction): `reportRoyalty` keeps retrying such an order from every status up to and
 * including `rescue_available` until its funding confirms, so the studio will still be told about — and
 * count — that payment even if this particular mint ends up a parentless self-rescue. Releasing the number in
 * that case would let a second order be reported under the same edition and double-count the studio's
 * `mintedEditions`. A reservation that never produced a royalty (`royaltyPaid` stayed null) was, by
 * construction, never counted by the studio, so releasing it cannot double-count anything.
 */
import { describe, expect, it } from 'vitest';
import { hasConfirmedReveal } from '../src/domain/order.js';
import {
  api,
  browserArtworkToPayment,
  browserCreateArtwork,
  browserMintToPayment,
  browserRescue,
  fundArtwork,
  fundCommit,
  makeHarness,
  regtestAddress,
  studioArtwork,
  type Harness,
} from './fakes/harness.js';
import type { Order } from '@bsh/degent-mint-sdk';

const CLUB = regtestAddress(5);
const artHarness = () => makeHarness({ settings: { serviceFeeAddress: CLUB } });
const getOrder = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

describe('p5.7: releasing a reserved/consumed edition when the mint never lands', () => {
  it('capped-2 artwork: A reserves edition 1, its funding is dropped before it can ever be revealed and A goes to rescue_available -> edition 1 returns and a later order gets it', async () => {
    const h = artHarness();

    // A plain order leases the collection's one parent UTXO and gets stuck retrying its broadcast, so the
    // artwork order below is detected as `paid` but dispatch never reaches it this tick (only one parent
    // lease exists fleet-wide) - it stays `queued`, exactly where a slow or contested reveal would leave it.
    h.broadcasters.standard.mode = 'retryable';
    const blocker = await browserMintToPayment(h);
    fundCommit(h, blocker);
    await h.worker.tick();
    expect((await getOrder(h, blocker.orderId)).status).toBe('revealing');

    const art = studioArtwork(h, { maxEditions: 2 });
    const a = await browserArtworkToPayment(h, art.id, { recipientSeed: 1 });
    fundArtwork(h, a); // full, correct split - a real, otherwise-valid 0-conf funding tx
    const rep = await h.worker.tick();
    expect(rep.transitions.filter((t) => t.orderId === a.orderId).map((t) => t.to)).toEqual(['paid', 'queued']);
    let oa = await getOrder(h, a.orderId);
    expect(oa.status).toBe('queued');
    expect(oa.edition).toBe(1);
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(1);

    // The funding transaction disappears (evicted from the mempool, or replaced under full-RBF) before the
    // order ever reached `revealing`: there is nothing left to reveal or self-rescue from that outpoint.
    h.chain.evict(a.commitTxid!);
    await h.worker.tick();
    oa = await getOrder(h, a.orderId);
    expect(oa.status).toBe('rescue_available');
    expect(oa.timeline.at(-1)!.detail).toMatch(/funding transaction dropped from the mempool/);
    expect(oa.edition).toBe(1); // the order's own historical record is unchanged
    expect(await h.editions.reservation(art.id, a.orderId)).toBeNull(); // but the reservation is gone
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(0); // edition 1 is free again

    // A later order for the capped-2 artwork gets the freed edition 1, and the cap still holds at 2.
    const b = await browserArtworkToPayment(h, art.id, { recipientSeed: 2 });
    expect(b.order.quote!.edition).toBe(1);
    const c = await browserArtworkToPayment(h, art.id, { recipientSeed: 3 });
    expect(c.order.quote!.edition).toBe(2);
    const { res: fourthRes } = await browserCreateArtwork(h, art.id, { recipientSeed: 4 });
    expect(fourthRes.status).toBe(409);
  });

  it('short royalty -> rescue_available releases the edition immediately (the artist was never paid, so the studio never counted it)', async () => {
    const h = artHarness();
    const art = studioArtwork(h, { maxEditions: 1 });
    const a = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, a, { royalty: 0n }); // artist output missing entirely
    await h.worker.tick();
    const oa = await getOrder(h, a.orderId);
    expect(oa.status).toBe('rescue_available');
    expect(oa.royaltyPaid).toBeNull();
    expect(await h.editions.reservation(art.id, a.orderId)).toBeNull();
    // The cap is 1, but the failed mint freed its slot: a second order can now take edition 1.
    const b = await browserArtworkToPayment(h, art.id, { recipientSeed: 9 });
    expect(b.order.quote!.edition).toBe(1);
  });

  it('a rescue timeout (paid too long without a reveal) also releases the edition when the artist was never paid', async () => {
    const h = artHarness();
    const art = studioArtwork(h, { maxEditions: 1 });
    const a = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, a, { royalty: 0n });
    h.broadcasters.standard.mode = 'retryable'; // irrelevant here: the order never reaches dispatch, it rescue_available's immediately on the short split
    await h.worker.tick();
    expect((await getOrder(h, a.orderId)).status).toBe('rescue_available');
    expect(await h.editions.reservation(art.id, a.orderId)).toBeNull();
  });

  it('the artist WAS paid (short club fee only) -> rescue_available does NOT release the edition: the studio will still be told once it confirms', async () => {
    const h = artHarness();
    const art = studioArtwork(h, { maxEditions: 1 });
    const a = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, a, { clubFee: 0n }); // artist paid in full, club fee missing
    await h.worker.tick();
    let oa = await getOrder(h, a.orderId);
    expect(oa.status).toBe('rescue_available');
    expect(oa.royaltyPaid).toMatchObject({ vout: 1 });
    expect(await h.editions.reservation(art.id, a.orderId)).toMatchObject({ edition: 1, consumed: true }); // NOT released
    // A second order for the same (cap 1) artwork is still refused: the number is still spoken for.
    const { res } = await browserCreateArtwork(h, art.id, { recipientSeed: 9 });
    expect(res.status).toBe(409);
    // Confirming lets the studio hear about it as usual (security review p5.5's own fix, unaffected here).
    h.chain.mine();
    await h.worker.tick();
    expect(h.studio!.royalties).toHaveLength(1);
    oa = await getOrder(h, a.orderId);
    expect(await h.editions.reservation(art.id, a.orderId)).toMatchObject({ edition: 1, consumed: true });
  });

  it('a confirmed edition is never released, even if release is attempted directly, and stays refused after the order moves on to delivered', async () => {
    const h = artHarness();
    const art = studioArtwork(h, { maxEditions: 2 });
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    await h.worker.tick(); // paid -> queued -> revealing -> revealed
    h.chain.mine();
    await h.worker.tick(); // revealed -> confirmed
    let rec = (await h.store.get(b.orderId))!;
    expect(rec.status).toBe('confirmed');
    expect(hasConfirmedReveal(rec)).toBe(true);
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(1);

    await h.orders.releaseEdition(rec); // must be a no-op
    expect(await h.editions.reservation(art.id, b.orderId)).toMatchObject({ edition: 1, consumed: true });
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(1);

    // A cap of 2 still shows only 1 taken, and the number stays refused after verified/delivered too.
    h.chain.inscriptions.set(rec.inscriptionId!, b.bytes);
    await h.worker.tick(); // confirmed -> verified -> delivered
    rec = (await h.store.get(b.orderId))!;
    expect(rec.status).toBe('delivered');
    await h.orders.releaseEdition(rec);
    expect(await h.editions.reservation(art.id, b.orderId)).toMatchObject({ edition: 1, consumed: true });
  });

  it('a rescued-without-parent order (child inscribed via self-rescue) keeps its own edition; the guard treats a self-rescued reveal as confirmed too', async () => {
    const h = artHarness();
    const art = studioArtwork(h, { maxEditions: 2 });
    const a = await browserArtworkToPayment(h, art.id, { recipientSeed: 1 });
    fundArtwork(h, a, { royalty: 0n }); // the artist is never paid in this funding tx: only a self-rescue is possible
    await h.worker.tick(); // paid -> rescue_available; royaltyPaid stays null, so the edition is released immediately
    let rec = (await h.store.get(a.orderId))!;
    expect(rec.status).toBe('rescue_available');
    expect(rec.edition).toBe(1); // the order's own historical assignment is untouched
    expect(await h.editions.reservation(art.id, a.orderId)).toBeNull();

    // Documented tradeoff (plan §3.7: duplicate on-chain editions are already tolerated, and are not
    // preventable in general): since the studio was never told about A's royalty (it never existed), it never
    // counted edition 1, so a second order for the same artwork can legitimately take it too.
    const b = await browserArtworkToPayment(h, art.id, { recipientSeed: 2 });
    expect(b.order.quote!.edition).toBe(1);

    // A can still self-rescue the commit it genuinely funded: the rescue reproduces the exact original
    // envelope (attribution edition 1, ADR-0005/plan §3.6), and that inscription is real once it confirms.
    const { rescue } = await browserRescue(h, a);
    await h.worker.tick();
    rec = (await h.store.get(a.orderId))!;
    expect(rec).toMatchObject({ status: 'revealed', rescued: true, revealTxid: rescue.txid });
    expect(hasConfirmedReveal(rec)).toBe(false); // not yet - only broadcast
    h.chain.mine();
    await h.worker.tick(); // revealed -> confirmed
    rec = (await h.store.get(a.orderId))!;
    expect(rec.status).toBe('confirmed');
    expect(rec.edition).toBe(1); // still keeps its own edition number
    expect(hasConfirmedReveal(rec)).toBe(true); // a self-rescue counts exactly like a parent-linked reveal
    await h.orders.releaseEdition(rec); // refused (and harmless - the reservation was already gone)
    expect(await h.editions.reservation(art.id, a.orderId)).toBeNull();
    expect(rec.edition).toBe(1);
  });
});
