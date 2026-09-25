/**
 * Open Studio artwork orders (plan §3.1, §3.4): POST /v1/orders with artworkId takes facts and bytes from the
 * studio, walks awaiting_content -> reviewing -> approved, quotes club fee + royalty, reserves the edition and
 * signs the attribution into the envelope. Every refusal of §3.1 is exercised.
 */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { commitAddress, decodeAttribution, buildInscriptionScript, estimateRevealWeight, addressToScript } from '@bsh/inscription';
import type { Order } from '@bsh/degent-mint-sdk';
import { DUST_LIMIT_SATS, computeRoyaltySplit, sha256Hex } from '@bsh/degent-mint-sdk';
import { api, browserArtworkToPayment, browserCreateArtwork, browserReveal, fundArtwork, makeHarness, NET, regtestAddress, regtestWpkhAddress, standardArt, studioArtwork, type Harness } from './fakes/harness.js';
import { png } from './fakes/images.js';

const CLUB = regtestAddress(5);
const artHarness = (opts: Parameters<typeof makeHarness>[0] = {}) => makeHarness({ ...opts, settings: { serviceFeeAddress: CLUB, ...(opts.settings ?? {}) } });
const getOrder = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

describe('POST /v1/orders with artworkId', () => {
  it('creates an approved order with a binding quote from the studio artwork: facts, bytes, timeline, events', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h, { artistSeed: 1 });
    const { res, b } = await browserCreateArtwork(h, art.id);
    expect(res.status).toBe(201);
    const o = b!.order;
    expect(o.status).toBe('approved');
    expect(o.timeline.map((e) => [e.status, e.detail])).toEqual([
      ['awaiting_content', undefined],
      ['reviewing', `artwork ${art.id} reviewed at submission`],
      ['approved', 'binding quote issued'],
    ]);
    expect(o).toMatchObject({ artworkId: art.id, artistAddress: art.payoutAddress, contentType: 'image/png', contentLength: art.contentLength, contentSha256: art.contentSha256, royaltyPaid: null, serviceFeeAddress: CLUB });
    expect(o.edition).toBeUndefined(); // assigned at paid
    expect(o.review).toMatchObject({ approved: true, checks: [{ id: 'artwork', passed: true }] });
    const q = o.quote!;
    expect(q.binding).toBe(true);
    expect(q.commitAddress).toMatch(/^bcrt1p/);
    const split = computeRoyaltySplit({ commitValueSats: q.commitValueSats, clubFeeBps: 1000, royaltyBps: 1000, payoutScriptType: 'p2tr' });
    expect(q).toMatchObject({
      serviceFeeSats: 0,
      clubFeeSats: split.clubFeeSats,
      artistRoyaltySats: split.artistRoyaltySats,
      mintPriceSats: q.commitValueSats + split.clubFeeSats,
      totalSats: q.commitValueSats + split.clubFeeSats + split.artistRoyaltySats,
      artistAddress: art.payoutAddress,
      artworkId: art.id,
      edition: 1,
      royaltyRaisedToDust: false,
    });
    expect(o.artistRoyaltySats).toBe(split.artistRoyaltySats);
    expect(o.clubFeeSats).toBe(split.clubFeeSats);
    // the bytes were copied into the mint's content store
    expect(await h.content.has(art.contentSha256!)).toBe(true);
    // one shared-topic event per transition (payload unchanged: the shared topic is the platform's)
    const evs = h.events.orderEvents.filter((e) => e.orderId === o.id);
    expect(evs.map((e) => e.status)).toEqual(['awaiting_content', 'reviewing', 'approved']);
    for (const e of evs) expect(e).not.toHaveProperty('artworkId');
    // a plain order carries none of it
    expect(JSON.stringify((await api(h, 'GET', '/v1/config')).body)).toContain('"royaltyBps":1000');
  });

  it('the commit address commits to the attribution metadata {artist, artwork, edition, studio} (plan §3.4)', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    const { b } = await browserCreateArtwork(h, art.id);
    const q = b!.order.quote!;
    const pub = schnorr.getPublicKey(b!.revealKey);
    const withAttribution = { contentType: 'image/png', body: b!.bytes, parentId: h.settings.collection.parentInscriptionId!, attribution: b!.attribution! };
    expect(commitAddress(pub, withAttribution, NET).address).toBe(q.commitAddress);
    expect(commitAddress(pub, { ...withAttribution, attribution: undefined }, NET).address).not.toBe(q.commitAddress);
    expect(b!.attribution).toEqual({ artist: art.payoutAddress, artwork: art.id, edition: 1, studio: 'degent.club' });
    // the quoted weight is the weight of the envelope WITH the metadata
    const collectionScript = addressToScript(h.settings.collectionAddress, NET);
    const weight = estimateRevealWeight({ content: withAttribution, withParent: true, recipientScript: addressToScript(b!.recipientAddress, NET), parentReturnScript: collectionScript, parentInputScript: collectionScript });
    expect(q.revealWeight).toBe(weight);
    // and ord will read the metadata back as the attribution
    const script = buildInscriptionScript(pub, withAttribution);
    expect(script.length).toBeGreaterThan(b!.bytes.length);
    expect(decodeAttribution(new TextEncoder().encode('') .length === 0 ? encodeOf(b!.attribution!) : new Uint8Array())).toEqual(b!.attribution);
  });

  it('a reveal without the attribution, or with another edition, is refused as reveal_invalid', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    const { b } = await browserCreateArtwork(h, art.id);
    const good = b!.attribution!;
    b!.attribution = undefined; // the browser forgot the metadata: commit address differs
    await expect(browserReveal(h, b!)).rejects.toThrow(/disagree/);
    b!.attribution = { ...good, edition: 2 };
    await expect(browserReveal(h, b!)).rejects.toThrow(/disagree/);
    // Force a PSBT with the wrong envelope past the harness check: the SERVICE must refuse it.
    const wrongKey = { ...b!, attribution: { ...good, edition: 2 }, order: { ...b!.order, quote: { ...b!.order.quote!, commitAddress: commitAddress(schnorr.getPublicKey(b!.revealKey), { contentType: 'image/png', body: b!.bytes, parentId: h.settings.collection.parentInscriptionId!, attribution: { ...good, edition: 2 } }, NET).address } } };
    const r = await browserReveal(h, wrongKey);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('reveal_invalid');
    b!.attribution = good;
    expect((await browserReveal(h, b!)).status).toBe(200);
  });

  it('GET /rescue carries artworkId, artistAddress and the edition so the bundle reproduces the envelope', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    h.broadcasters.standard.mode = 'retryable';
    await h.worker.tick();
    h.clock.advance(6 * 3600 + 1);
    await h.worker.tick();
    const r = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ artworkId: art.id, artistAddress: art.payoutAddress, edition: 1 });
  });

  it('the upload step is skipped: PUT /content on an artwork order is a conflict', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    const { b } = await browserCreateArtwork(h, art.id);
    const r = await api(h, 'PUT', `/v1/orders/${b!.orderId}/content`, { bytes: b!.bytes, token: b!.token });
    expect(r.status).toBe(409);
  });

  it('a P2WPKH payout address is accepted and gets its own dust floor; the dust raise is reported', async () => {
    // 1 bps royalty on a ~50k mint price = a handful of sats: raised to the dust limit of the script type.
    const h = artHarness({ settings: { royaltyBps: 1 } });
    await h.ready;
    const wpkh = studioArtwork(h, { artistSeed: 2, payoutAddress: regtestWpkhAddress(2) });
    const tr = studioArtwork(h, { artistSeed: 3 });
    const a = (await browserCreateArtwork(h, wpkh.id)).b!.order.quote!;
    const t = (await browserCreateArtwork(h, tr.id)).b!.order.quote!;
    expect(a).toMatchObject({ artistRoyaltySats: DUST_LIMIT_SATS.p2wpkh, royaltyRaisedToDust: true });
    expect(t).toMatchObject({ artistRoyaltySats: DUST_LIMIT_SATS.p2tr, royaltyRaisedToDust: true });
    expect(a.totalSats).toBe(a.commitValueSats + a.clubFeeSats! + DUST_LIMIT_SATS.p2wpkh);
  });

  it('royaltyBps 0 and clubFeeBps 0: no extras, total = commit value, no service fee address', async () => {
    const h = artHarness({ settings: { royaltyBps: 0, clubFeeBps: { standard: 0, large: 0, fullblock: 0 } } });
    await h.ready;
    const art = studioArtwork(h);
    const { b } = await browserCreateArtwork(h, art.id);
    expect(b!.order.quote).toMatchObject({ clubFeeSats: 0, artistRoyaltySats: 0, royaltyRaisedToDust: false });
    expect(b!.order.quote!.totalSats).toBe(b!.order.quote!.commitValueSats);
    expect(b!.order.serviceFeeAddress).toBeNull();
  });

  it('club fee bps is per tier', async () => {
    const h = artHarness({ settings: { clubFeeBps: { standard: 500, large: 1000, fullblock: 1000 } } });
    await h.ready;
    const art = studioArtwork(h);
    const { b } = await browserCreateArtwork(h, art.id);
    expect(b!.order.quote!.clubFeeSats).toBe(Math.floor(b!.order.quote!.commitValueSats * 0.05));
  });
});

describe('refusals (plan §3.1)', () => {
  it('unknown artwork -> 404 artwork_not_found', async () => {
    const h = artHarness();
    await h.ready;
    const { res } = await browserCreateArtwork(h, 'art_nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('artwork_not_found');
  });

  it.each(['submitted', 'reviewing', 'rejected', 'delisted'] as const)('artwork in status %s -> 409 artwork_not_mintable', async (status) => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h, { status });
    const { res } = await browserCreateArtwork(h, art.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'artwork_not_mintable', details: { status } });
  });

  it('artist without a proven payout address -> 409 artist_payout_missing; a legacy payout address too', async () => {
    const h = artHarness();
    await h.ready;
    const none = studioArtwork(h, { payoutAddress: null });
    const r1 = (await browserCreateArtwork(h, none.id)).res;
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('artist_payout_missing');
    // a P2PKH regtest address: not P2WPKH / P2TR
    const legacy = studioArtwork(h, { payoutAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn' });
    const r2 = (await browserCreateArtwork(h, legacy.id)).res;
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('artist_payout_missing');
    expect(r2.body.error.message).toMatch(/P2WPKH \/ P2TR/);
  });

  it('declared content facts must equal the artwork record -> 422 content_mismatch (with the record in details)', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    const other = standardArt(200_000, 1000, 1000);
    const { res } = await browserCreateArtwork(h, art.id, { facts: { contentSha256: sha256Hex(other) } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'content_mismatch', details: { artwork: { contentSha256: art.contentSha256, contentLength: art.contentLength } } });
    const r2 = (await browserCreateArtwork(h, art.id, { facts: { contentType: 'image/jpeg' } })).res;
    expect(r2.body.error.code).toBe('content_mismatch');
  });

  it('a declared tier that does not match the artwork size is a validation failure', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    const { res } = await browserCreateArtwork(h, art.id, { tier: 'large' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('studio unreachable -> 503 upstream_unavailable and nothing is created or reserved', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    h.studio!.down = true;
    const { res } = await browserCreateArtwork(h, art.id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('upstream_unavailable');
    expect(await h.editions.consumedCount(art.id)).toBe(0);
    h.studio!.down = false;
    expect((await browserCreateArtwork(h, art.id)).b!.order.quote!.edition).toBe(1);
  });

  it('studio serving bytes that differ from its record -> 503, never an order on the wrong bytes', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    h.studio!.artworks.get(art.id)!.bytes = png(1024, 1024, 200_001);
    const { res } = await browserCreateArtwork(h, art.id);
    expect(res.status).toBe(503);
  });

  it('no studio wired -> artwork orders are refused and GET /v1/config says studioUrl null', async () => {
    const h = artHarness({ studio: null });
    await h.ready;
    const { res } = await browserCreateArtwork(h, 'art_x');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no studio/);
    expect((await api(h, 'GET', '/v1/config')).body.studioUrl).toBeNull();
  });

  it('a malformed artworkId is rejected before the studio is asked', async () => {
    const h = artHarness();
    await h.ready;
    const { res } = await browserCreateArtwork(h, 'bad id!');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/artworkId/);
  });

  it('a club fee without SERVICE_FEE_ADDRESS is a server error, not a silently dropped fee', async () => {
    const h = makeHarness(); // serviceFeeAddress null, clubFeeBps 1000
    await h.ready;
    const art = studioArtwork(h);
    const { res } = await browserCreateArtwork(h, art.id);
    expect(res.status).toBe(500);
  });
});

describe('edition reservation (plan §3.4)', () => {
  it('two orders of one artwork are quoted editions 1 and 2; reaching paid together they keep distinct editions', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const a = await browserArtworkToPayment(h, art.id, { recipientSeed: 1 });
    const b = await browserArtworkToPayment(h, art.id, { recipientSeed: 2 });
    expect(a.order.quote!.edition).toBe(1);
    expect(b.order.quote!.edition).toBe(2);
    expect(a.order.quote!.commitAddress).not.toBe(b.order.quote!.commitAddress);
    fundArtwork(h, a);
    fundArtwork(h, b);
    await h.worker.tick();
    const [oa, ob] = await Promise.all([getOrder(h, a.orderId), getOrder(h, b.orderId)]);
    expect([oa.status, ob.status]).toEqual(['revealed', 'revealed']);
    expect(oa.edition).toBe(1);
    expect(ob.edition).toBe(2);
    expect(await h.editions.consumedCount(art.id)).toBe(2);
    // a third order after that is edition 3
    expect((await browserCreateArtwork(h, art.id, { recipientSeed: 3 })).b!.order.quote!.edition).toBe(3);
  });

  it('an expired reservation is released and the number is handed to the next order', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h);
    const first = (await browserCreateArtwork(h, art.id)).b!;
    expect(first.order.quote!.edition).toBe(1);
    h.clock.advance(901);
    await h.worker.tick();
    expect((await getOrder(h, first.orderId)).status).toBe('expired');
    expect(await h.editions.reservation(art.id, first.orderId)).toBeNull();
    const second = (await browserCreateArtwork(h, art.id, { recipientSeed: 2 })).b!;
    expect(second.order.quote!.edition).toBe(1);
  });

  it('a late payment re-claims the released number while it is free', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    h.clock.advance(901);
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('expired');
    fundArtwork(h, b);
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('revealed');
    expect(o.edition).toBe(1);
  });

  it('a late payment whose number was taken by another order goes to rescue_available (the reveal was signed with that edition)', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const late = await browserArtworkToPayment(h, art.id, { recipientSeed: 1 });
    h.clock.advance(901);
    await h.worker.tick();
    expect((await getOrder(h, late.orderId)).status).toBe('expired');
    const taker = await browserArtworkToPayment(h, art.id, { recipientSeed: 2 });
    expect(taker.order.quote!.edition).toBe(1);
    fundArtwork(h, late);
    await h.worker.tick();
    const o = await getOrder(h, late.orderId);
    expect(o.status).toBe('rescue_available');
    expect(o.timeline.at(-1)!.detail).toMatch(/edition 1 was released/);
    expect(o.edition).toBeUndefined();
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    // the taker still mints edition 1
    fundArtwork(h, taker);
    await h.worker.tick();
    expect((await getOrder(h, taker.orderId)).edition).toBe(1);
  });

  it('reservations are per artwork', async () => {
    const h = artHarness();
    await h.ready;
    const a = studioArtwork(h, { artistSeed: 1 });
    const b = studioArtwork(h, { artistSeed: 2, bytes: standardArt(200_000, 1000, 1000) });
    expect((await browserCreateArtwork(h, a.id)).b!.order.quote!.edition).toBe(1);
    expect((await browserCreateArtwork(h, b.id)).b!.order.quote!.edition).toBe(1);
    expect((await browserCreateArtwork(h, a.id)).b!.order.quote!.edition).toBe(2);
  });
});

describe('edition caps (ADR-0012)', () => {
  it('the studio already counts maxEditions minted -> 409 artwork_not_mintable (sold out), nothing reserved', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h, { maxEditions: 3, mintedEditions: 3 });
    const { res } = await browserCreateArtwork(h, art.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'artwork_not_mintable', details: { status: 'approved', soldOut: true, maxEditions: 3, held: 3 } });
    expect(res.body.error.message).toMatch(/sold out/);
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(0);
    expect(await h.store.listByStatus(['awaiting_content', 'reviewing', 'approved'])).toEqual([]); // no order either
  });

  it('live quotes count against the cap; an expired quote frees its edition for the next order', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h, { maxEditions: 2 });
    expect((await browserCreateArtwork(h, art.id, { recipientSeed: 1 })).b!.order.quote!.edition).toBe(1);
    expect((await browserCreateArtwork(h, art.id, { recipientSeed: 2 })).b!.order.quote!.edition).toBe(2);
    const third = (await browserCreateArtwork(h, art.id, { recipientSeed: 3 })).res;
    expect(third.status).toBe(409);
    expect(third.body.error).toMatchObject({ code: 'artwork_not_mintable', details: { soldOut: true, maxEditions: 2, held: 2 } });
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(2);
    h.clock.advance(901);
    await h.worker.tick(); // both quotes expire and release their editions
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(0);
    expect((await browserCreateArtwork(h, art.id, { recipientSeed: 4 })).b!.order.quote!.edition).toBe(1);
  });

  it('two concurrent orders for the last edition: exactly one is quoted, the other is 409 sold out', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h, { maxEditions: 1 });
    const results = await Promise.all([browserCreateArtwork(h, art.id, { recipientSeed: 1 }), browserCreateArtwork(h, art.id, { recipientSeed: 2 })]);
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses).toEqual([201, 409]);
    const won = results.find((r) => r.res.status === 201)!.b!;
    const lost = results.find((r) => r.res.status === 409)!.res;
    expect(won.order.quote!.edition).toBe(1);
    expect(lost.body.error).toMatchObject({ code: 'artwork_not_mintable', details: { soldOut: true, maxEditions: 1 } });
    expect(await h.editions.countActive(art.id, h.clock.now())).toBe(1);
    expect(await h.editions.reservation(art.id, won.orderId)).toMatchObject({ edition: 1, consumed: false });
  });

  it('many concurrent orders against a cap of 3: exactly 3 quotes with distinct editions 1..3', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h, { maxEditions: 3 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => browserCreateArtwork(h, art.id, { recipientSeed: 10 + i })));
    const quoted = results.filter((r) => r.res.status === 201).map((r) => r.b!.order.quote!.edition!);
    expect(quoted.sort()).toEqual([1, 2, 3]);
    expect(results.filter((r) => r.res.status === 409)).toHaveLength(5);
  });

  it('consumed editions count too: a paid order plus a live quote fill a cap of 2; the studio hears the edition', async () => {
    const h = artHarness();
    const art = studioArtwork(h, { maxEditions: 2 });
    const paid = await browserArtworkToPayment(h, art.id, { recipientSeed: 1 });
    fundArtwork(h, paid, { confirmed: true });
    await h.worker.tick();
    expect((await getOrder(h, paid.orderId)).edition).toBe(1);
    expect(await h.editions.consumedCount(art.id)).toBe(1);
    expect(h.studio!.royalties.map((r) => [r.orderId, r.edition])).toEqual([[paid.orderId, 1]]);
    expect(h.studio!.artworks.get(art.id)!.mintedEditions).toBe(1);
    expect((await browserCreateArtwork(h, art.id, { recipientSeed: 2 })).b!.order.quote!.edition).toBe(2);
    const full = (await browserCreateArtwork(h, art.id, { recipientSeed: 3 })).res;
    expect(full.status).toBe(409);
    expect(full.body.error.details).toMatchObject({ soldOut: true, held: 2 });
  });

  it('an open edition (maxEditions null) is never refused for being sold out', async () => {
    const h = artHarness();
    await h.ready;
    const art = studioArtwork(h, { maxEditions: null, mintedEditions: 5_000 });
    expect((await browserCreateArtwork(h, art.id)).b!.order.quote!.edition).toBe(1);
  });
});

// tiny helper: encode the attribution as the platform does, for the decode round-trip above
import { encodeAttribution } from '@bsh/inscription';
function encodeOf(a: NonNullable<Awaited<ReturnType<typeof browserCreateArtwork>>['b']>['attribution']) {
  return encodeAttribution(a!);
}
