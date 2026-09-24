/**
 * Worker verification of the Open Studio split (plan §3.3): artist and club outputs compared by SCRIPT, never
 * address; short or missing outputs -> rescue_available and the parent is never co-signed; royaltyPaid and the
 * edition recorded at paid; degent.mint.royalty.paid emitted and the studio posted (retried, idempotent);
 * the ledger order, intent and observation recorded (never blocking).
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { addressToScript } from '@bsh/inscription';
import type { Order } from '@bsh/degent-mint-sdk';
import { checkFundingOutputs, retryDelayMs } from '../src/domain/royalty.js';
import { api, browserArtworkToPayment, fundArtwork, makeHarness, NET, regtestAddress, studioArtwork, type Harness } from './fakes/harness.js';

const CLUB = regtestAddress(5);
const artHarness = (opts: Parameters<typeof makeHarness>[0] = {}) => makeHarness({ ...opts, settings: { serviceFeeAddress: CLUB, ...(opts.settings ?? {}) } });
const getOrder = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

describe('checkFundingOutputs (pure)', () => {
  const artist = bytesToHex(addressToScript(regtestAddress(61), NET));
  const club = bytesToHex(addressToScript(CLUB, NET));
  const out = (scriptHex: string, value: bigint) => ({ scriptHex, value, address: null });

  it('sums every output paying a script and compares against the quoted minimums', () => {
    const c = checkFundingOutputs({ outputs: [out('5120' + '00'.repeat(32), 50_000n), out(artist, 300n), out(club, 500n), out(artist, 300n)], artistScriptHex: artist, artistRoyaltySats: 600, clubScriptHex: club, clubFeeSats: 500 });
    expect(c.ok).toBe(true);
    expect(c.artist).toMatchObject({ paidSats: 600, vouts: [1, 3], ok: true });
    expect(c.club).toMatchObject({ paidSats: 500, vouts: [2], ok: true });
    expect(c.detail).toBe('');
  });

  it('names the short or missing output; scripts are compared case-insensitively', () => {
    const short = checkFundingOutputs({ outputs: [out(artist.toUpperCase(), 599n), out(club, 500n)], artistScriptHex: artist, artistRoyaltySats: 600, clubScriptHex: club, clubFeeSats: 500 });
    expect(short.ok).toBe(false);
    expect(short.detail).toBe('artist royalty short (599 < 600 sats)');
    const missing = checkFundingOutputs({ outputs: [out(artist, 600n)], artistScriptHex: artist, artistRoyaltySats: 600, clubScriptHex: club, clubFeeSats: 500 });
    expect(missing.detail).toMatch(/club fee output missing \(expected 500 sats/);
    const both = checkFundingOutputs({ outputs: [], artistScriptHex: artist, artistRoyaltySats: 600, clubScriptHex: club, clubFeeSats: 500 });
    expect(both.detail).toMatch(/artist royalty output missing.*; club fee output missing/);
  });

  it('a zero expectation or no script means nothing to check', () => {
    const c = checkFundingOutputs({ outputs: [], artistScriptHex: null, artistRoyaltySats: 0, clubScriptHex: club, clubFeeSats: 0 });
    expect(c).toMatchObject({ ok: true, artist: null, club: null });
  });

  it('retry backoff doubles from 30 s and caps at 1 h', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(30)).toBe(3_600_000);
  });
});

describe('worker: the studio split in the funding transaction', () => {
  it('full payment: paid with royaltyPaid and the edition, queued, revealed; royalty.paid emitted; studio posted once', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    const rep = await h.worker.tick();
    expect(rep.errors).toEqual([]);
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued', 'revealing', 'revealed']);
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('revealed');
    expect(o.edition).toBe(1);
    expect(o.royaltyPaid).toEqual({ txid: b.commitTxid, vout: 1, sats: b.order.quote!.artistRoyaltySats });
    // event
    const ev = h.events.royaltyEvents;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({
      type: 'degent.mint.royalty.paid',
      eventId: `${b.orderId}:royalty`,
      orderId: b.orderId,
      network: 'regtest',
      artworkId: art.id,
      artist: art.payoutAddress,
      sats: b.order.quote!.artistRoyaltySats,
      txid: b.commitTxid,
      vout: 1,
      at: expect.any(String),
      edition: 1,
    });
    // studio record (idempotent on orderId): exactly one, with the funding txid and output 1
    expect(h.studio!.royalties).toEqual([
      { orderId: b.orderId, artworkId: art.id, minterAddress: b.recipientAddress, royaltySats: b.order.quote!.artistRoyaltySats, fundingTxid: b.commitTxid, vout: 1, at: expect.any(String) },
    ]);
    await h.worker.tick();
    await h.worker.tick();
    expect(h.studio!.postCalls).toBe(1);
    expect(h.events.royaltyEvents).toHaveLength(1);
    const rec = (await h.store.get(b.orderId))!;
    expect(rec.royaltyReport).toMatchObject({ reportedAt: expect.any(String), emittedAt: expect.any(String), attempts: 1, gaveUp: false });
  });

  it('the royalty output may sit at any index and be split: scripts are summed, address strings never used', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    const q = b.order.quote!;
    const script = (a: string) => bytesToHex(addressToScript(a, NET));
    const half = BigInt(q.artistRoyaltySats!) / 2n;
    h.chain.addTx({
      txid: b.commitTxid!,
      vin: [],
      vout: [
        { value: half, scriptHex: script(q.artistAddress!) },
        { value: BigInt(q.commitValueSats), scriptHex: script(q.commitAddress!) },
        { value: BigInt(q.clubFeeSats!), scriptHex: script(CLUB) },
        { value: BigInt(q.artistRoyaltySats!) - half, scriptHex: script(q.artistAddress!) },
      ],
    });
    // the commit is at vout 1 here: the browser told us vout 0, so this is a wrong commit outpoint -> failed (existing rule)
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('failed');
    // same layout with the commit at vout 0
    const c = await browserArtworkToPayment(h, art.id, { recipientSeed: 2 });
    const cq = c.order.quote!;
    const chalf = BigInt(cq.artistRoyaltySats!) / 2n;
    h.chain.addTx({
      txid: c.commitTxid!,
      vin: [],
      vout: [
        { value: BigInt(cq.commitValueSats), scriptHex: script(cq.commitAddress!) },
        { value: BigInt(cq.clubFeeSats!), scriptHex: script(CLUB) },
        { value: chalf, scriptHex: script(cq.artistAddress!) },
        { value: BigInt(cq.artistRoyaltySats!) - chalf, scriptHex: script(cq.artistAddress!) },
      ],
    });
    await h.worker.tick();
    const o = await getOrder(h, c.orderId);
    expect(o.status).toBe('revealed');
    expect(o.royaltyPaid).toEqual({ txid: c.commitTxid, vout: 2, sats: cq.artistRoyaltySats });
  });

  it('short royalty -> paid then rescue_available naming the output; parent never co-signed; nothing posted', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { royalty: BigInt(b.order.quote!.artistRoyaltySats!) - 1n });
    const rep = await h.worker.tick();
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'rescue_available']);
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('rescue_available');
    expect(o.timeline.at(-1)!.detail).toMatch(/artist royalty short \(\d+ < \d+ sats\)/);
    expect(o.royaltyPaid).toBeNull();
    expect(o.edition).toBe(1); // assigned at paid, even so
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    expect(h.studio!.royalties).toHaveLength(0);
    expect(h.events.royaltyEvents).toHaveLength(0);
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('rescue_available');
  });

  it('short club fee -> rescue_available; the artist WAS paid, so royaltyPaid is recorded and reported', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { clubFee: BigInt(b.order.quote!.clubFeeSats!) - 10n });
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('rescue_available');
    expect(o.timeline.at(-1)!.detail).toMatch(/club fee short/);
    expect(o.royaltyPaid).toMatchObject({ vout: 1 });
    expect(h.studio!.royalties).toHaveLength(1);
    expect(h.broadcasters.standard.sent).toHaveLength(0);
  });

  it('royalty paid to the wrong script (another address) -> rescue_available "output missing"', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { royaltyTo: regtestAddress(99) });
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('rescue_available');
    expect(o.timeline.at(-1)!.detail).toMatch(/artist royalty output missing/);
    expect(o.royaltyPaid).toBeNull();
  });

  it('club fee to the wrong script -> rescue_available', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { clubTo: regtestAddress(98) });
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).timeline.at(-1)!.detail).toMatch(/club fee output missing/);
  });

  it('both outputs missing -> rescue_available naming both', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { royalty: 0n, clubFee: 0n });
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).timeline.at(-1)!.detail).toMatch(/artist royalty output missing.*club fee output missing/);
  });

  it('wrong commit value still fails the order (the existing rule runs first)', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { commitValue: BigInt(b.order.quote!.commitValueSats) + 1n });
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('failed');
    expect(h.studio!.royalties).toHaveLength(0);
  });

  it('RBF-signalling unconfirmed funding: paid and revealed as today, but royalty.paid and the studio post wait for the block', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b, { rbf: true });
    await h.worker.tick();
    let o = await getOrder(h, b.orderId);
    expect(o.status).toBe('revealed');
    expect(o.royaltyPaid).toMatchObject({ vout: 1 });
    expect(o.timeline.find((e) => e.status === 'paid')!.detail).toBe('commit seen in mempool (replaceable)');
    expect(h.events.royaltyEvents).toHaveLength(0);
    expect(h.studio!.royalties).toHaveLength(0);
    await h.worker.tick();
    expect(h.studio!.royalties).toHaveLength(0);
    h.chain.mine();
    await h.worker.tick();
    expect(h.events.royaltyEvents).toHaveLength(1);
    expect(h.studio!.royalties).toHaveLength(1);
    o = await getOrder(h, b.orderId);
    expect(o.status).toBe('confirmed');
  });

  it('studio post failing: the mint proceeds; the post is retried with backoff on later ticks until it lands', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    h.studio!.failPosts = 2;
    const rep = await h.worker.tick();
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued', 'revealing', 'revealed']);
    expect(h.events.royaltyEvents).toHaveLength(1); // the event does not wait for the studio
    expect(h.studio!.royalties).toHaveLength(0);
    expect(h.studio!.postCalls).toBe(1);
    let rec = (await h.store.get(b.orderId))!;
    expect(rec.royaltyReport).toMatchObject({ attempts: 1, reportedAt: null, lastError: expect.stringMatching(/503/) });
    await h.worker.tick(); // inside the backoff window: no call
    expect(h.studio!.postCalls).toBe(1);
    h.clock.advance(31);
    await h.worker.tick(); // second attempt fails too
    expect(h.studio!.postCalls).toBe(2);
    h.clock.advance(31);
    await h.worker.tick(); // still inside the 60 s window
    expect(h.studio!.postCalls).toBe(2);
    h.clock.advance(31);
    await h.worker.tick();
    expect(h.studio!.postCalls).toBe(3);
    expect(h.studio!.royalties).toHaveLength(1);
    rec = (await h.store.get(b.orderId))!;
    expect(rec.royaltyReport).toMatchObject({ attempts: 3, reportedAt: expect.any(String), lastError: null });
    expect(h.events.royaltyEvents).toHaveLength(1); // emitted once
  });

  it('studio down entirely does not block confirmation, verification or delivery', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    h.studio!.down = true;
    await h.worker.tick();
    h.chain.mine();
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('confirmed');
    h.chain.inscriptions.set(o.inscriptionId!, b.bytes);
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('delivered');
    h.studio!.down = false;
    h.clock.advance(3600);
    await h.worker.tick(); // delivered orders are still reported
    expect(h.studio!.royalties).toHaveLength(1);
  });

  it('a non-retryable studio refusal (409 conflicting facts) stops the retries and is flagged for an operator', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    h.studio!.rejectPosts = 1;
    await h.worker.tick();
    h.clock.advance(3600);
    await h.worker.tick();
    expect(h.studio!.postCalls).toBe(1);
    expect((await h.store.get(b.orderId))!.royaltyReport).toMatchObject({ gaveUp: true, reportedAt: null, lastError: expect.stringMatching(/409/) });
  });

  it('a plain (non-artwork) order is untouched by any of this', async () => {
    const h = artHarness();
    const { browserMintToPayment, fundCommit } = await import('./fakes/harness.js');
    const b = await browserMintToPayment(h);
    expect(b.order.artworkId).toBeUndefined();
    expect(b.order.quote!.clubFeeSats).toBeUndefined();
    fundCommit(h, b);
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    expect(o.status).toBe('revealed');
    expect(o).not.toHaveProperty('royaltyPaid');
    expect(o).not.toHaveProperty('edition');
    expect(h.events.royaltyEvents).toHaveLength(0);
    expect(h.ledger!.orders).toHaveLength(0);
  });
});

describe('worker: ledger recording (plan §3.5)', () => {
  it('creating an artwork order records a ledger order with payee line items and a psbt intent whose outputs are the funding layout', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    const q = b.order.quote!;
    expect(h.ledger!.orders).toHaveLength(1);
    const lo = h.ledger!.orders[0]!;
    expect(lo.input.customerRef).toBe(b.recipientAddress);
    expect(lo.input.idempotencyKey).toBe(`degent-mint:${b.orderId}:order`);
    expect(lo.input.metadata).toMatchObject({ mintOrderId: b.orderId, artworkId: art.id, edition: '1', tier: 'standard', network: 'regtest' });
    expect(lo.input.lineItems).toEqual([
      { sku: 'network-cost', description: expect.stringMatching(/commit output/), quantity: 1, unitSats: q.commitValueSats, payee: { kind: 'platform', ref: 'commit', address: q.commitAddress } },
      { sku: 'club-fee', description: 'Degent Club fee', quantity: 1, unitSats: q.clubFeeSats, payee: { kind: 'club', ref: 'degent-club', address: CLUB } },
      { sku: 'artist-royalty', description: `Artist royalty for artwork ${art.id}`, quantity: 1, unitSats: q.artistRoyaltySats, payee: { kind: 'artist', ref: art.payoutAddress, address: art.payoutAddress } },
    ]);
    expect(lo.totalSats).toBe(q.totalSats);
    expect(lo.payments).toHaveLength(1);
    expect(lo.payments[0]!.input.idempotencyKey).toBe(`degent-mint:${b.orderId}:payment`);
    const script = (a: string) => bytesToHex(addressToScript(a, NET));
    expect(lo.payments[0]!.outputs).toEqual([
      { scriptHex: script(q.commitAddress!), valueSats: q.commitValueSats, address: q.commitAddress },
      { scriptHex: script(CLUB), valueSats: q.clubFeeSats, address: CLUB },
      { scriptHex: script(art.payoutAddress!), valueSats: q.artistRoyaltySats, address: art.payoutAddress },
    ]);
    const rec = (await h.store.get(b.orderId))!;
    expect(rec.ledger).toMatchObject({ orderId: lo.id, paymentId: lo.payments[0]!.id, observedAt: null });
  });

  it('after payment the funding transaction is reported: pending while unconfirmed, paid with three payouts once mined', async () => {
    const h = artHarness();
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    await h.worker.tick();
    const p = h.ledger!.orders[0]!.payments[0]!;
    expect(p.observations).toHaveLength(1);
    expect(p.observations[0]).toMatchObject({ txid: b.commitTxid, confirmations: 0, rbfSignalled: false });
    expect(p.observations[0]!.outputs).toHaveLength(4); // commit, royalty, club, change: every output, in vout order
    expect(p.status).toBe('pending');
    let rec = (await h.store.get(b.orderId))!;
    expect(rec.ledger).toMatchObject({ observedAt: expect.any(String), observedConfirmed: false });
    await h.worker.tick();
    expect(p.observations).toHaveLength(1); // not re-reported while unconfirmed
    h.chain.mine();
    await h.worker.tick();
    expect(p.observations).toHaveLength(2);
    expect(p.observations[1]!.confirmations).toBe(1);
    expect(p.status).toBe('paid');
    expect(p.payouts.map((x) => [x.payee.kind, x.amountSats, x.vout])).toEqual([
      ['platform', b.order.quote!.commitValueSats, 0],
      ['club', b.order.quote!.clubFeeSats, 2],
      ['artist', b.order.quote!.artistRoyaltySats, 1],
    ]);
    rec = (await h.store.get(b.orderId))!;
    expect(rec.ledger!.observedConfirmed).toBe(true);
    await h.worker.tick();
    expect(p.observations).toHaveLength(2); // done
  });

  it('a ledger outage never blocks the order; the order and intent are recorded later with backoff, then the observation', async () => {
    const h = artHarness();
    h.ledger!.down = true;
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    expect(b.order.status).toBe('awaiting_payment');
    expect(h.ledger!.orders).toHaveLength(0);
    let rec = (await h.store.get(b.orderId))!;
    expect(rec.ledger).toMatchObject({ orderId: null, paymentId: null, attempts: 1, lastError: expect.stringMatching(/unreachable/) });
    fundArtwork(h, b);
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('revealed');
    h.ledger!.down = false;
    await h.worker.tick(); // inside the backoff
    expect(h.ledger!.orders).toHaveLength(0);
    h.clock.advance(31);
    await h.worker.tick();
    expect(h.ledger!.orders).toHaveLength(1);
    rec = (await h.store.get(b.orderId))!;
    expect(rec.ledger!.paymentId).toBeTruthy();
    await h.worker.tick();
    expect(h.ledger!.orders[0]!.payments[0]!.observations).toHaveLength(1);
  });

  it('no ledger wired: nothing recorded, nothing fails', async () => {
    const h = artHarness({ ledger: null });
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    const rep = await h.worker.tick();
    expect(rep.errors).toEqual([]);
    expect((await h.store.get(b.orderId))!.ledger).toBeNull();
  });
});
