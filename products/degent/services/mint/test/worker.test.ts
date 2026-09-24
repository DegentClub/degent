import { describe, expect, it } from 'vitest';
import type { Order } from '@bsh/degent-mint-sdk';
import { api, browserCreate, browserMintToPayment, browserUpload, fullBlockArt, fundCommit, largeArt, makeHarness, regtestAddress, type Harness } from './fakes/harness.js';
import { png } from './fakes/images.js';

const status = async (h: Harness, id: string) => ((await api(h, 'GET', `/v1/orders/${id}`)).body as Order).status;
/** A Standard Degent at the top of its byte range: > 400,000 WU, so it travels the block lane (ADR-0005 §3). */
const heavyStandardArt = (seed: number) => png(1000 + seed, 1000, 400_000);

describe('worker: expiry and payment', () => {
  it('expires unpaid orders in every pre-paid state after the quote TTL', async () => {
    const h = makeHarness();
    await h.ready;
    const a = await browserCreate(h); // awaiting_content
    const b = await browserCreate(h);
    await browserUpload(h, b); // approved
    const c = await browserMintToPayment(h); // awaiting_payment
    h.clock.advance(899);
    await h.worker.tick();
    expect(await status(h, a.orderId)).toBe('awaiting_content');
    h.clock.advance(2);
    const rep = await h.worker.tick();
    expect(rep.transitions.filter((t) => t.to === 'expired')).toHaveLength(3);
    for (const x of [a, b, c]) expect(await status(h, x.orderId)).toBe('expired');
  });

  it('honours a late payment of an expired order (fee is fixed in the commit)', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    h.clock.advance(1000);
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('expired');
    fundCommit(h, b);
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('revealed');
  });

  it('service fee not paid -> rescue offered, never co-signed', async () => {
    const h = makeHarness({ settings: { serviceFeeAddress: regtestAddress(5) } });
    h.settings.collection.serviceFeeSats = { standard: 5000, large: 5000, fullblock: 5000 };
    const b = await browserMintToPayment(h);
    expect(b.order.quote!.totalSats).toBe(b.order.quote!.commitValueSats + 5000);
    fundCommit(h, b);
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('rescue_available');
    expect(h.broadcasters.standard.sent).toHaveLength(0);
  });
});

describe('worker: lanes (ADR-0005 §4 block-lane weight budget)', () => {
  it('three Large Degents of ~1.2M WU each are revealed in one block; a fourth waits for the next', async () => {
    const h = makeHarness();
    const orders = [];
    for (let i = 1; i <= 4; i++) orders.push(await browserMintToPayment(h, { bytes: largeArt(i), recipientSeed: i }));
    for (const o of orders) {
      expect(o.order.tier).toBe('large');
      expect(o.order.quote!.lane).toBe('block');
      expect(o.order.quote!.revealWeight).toBeGreaterThan(1_190_000);
      expect(o.order.quote!.revealWeight).toBeLessThan(1_210_000);
    }
    // Unpaid orders hold no block slot, so every quote says slot 1 until payment; the live position
    // (GET /orders/{id}.queue) is recomputed from the paid queue.
    expect(orders.map((o) => o.order.quote!.queuePosition)).toEqual([1, 1, 1, 1]);
    expect(orders.map((o) => o.order.quote!.etaMinutes)).toEqual([10, 10, 10, 10]);
    for (const o of orders) fundCommit(h, o);
    await h.worker.tick();
    const st = await Promise.all(orders.map((o) => status(h, o.orderId)));
    expect(st).toEqual(['revealed', 'revealed', 'revealed', 'queued']);
    const q = await api(h, 'GET', '/v1/queue');
    expect(q.body.block).toMatchObject({ waiting: 1, inFlight: 3, weightBudget: 3_990_000 });
    expect(q.body.block.inFlightWeight).toBe(orders.slice(0, 3).reduce((a, o) => a + o.order.quote!.revealWeight, 0));
    expect(q.body.block.inFlightWeight).toBeLessThanOrEqual(3_990_000);
    const queued = (await api(h, 'GET', `/v1/orders/${orders[3]!.orderId}`)).body as Order;
    expect(queued.queue).toEqual({ lane: 'block', position: 2, etaMinutes: 20 });
    // Same block: the three reveals chain on each other (input 0 = previous reveal's output 0).
    const sent = h.broadcasters.block.sent;
    expect(sent).toHaveLength(3);
    await h.worker.tick();
    expect(await status(h, orders[3]!.orderId)).toBe('queued');
    h.chain.mine();
    await h.worker.tick();
    expect(await Promise.all(orders.slice(0, 3).map((o) => status(h, o.orderId)))).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(await status(h, orders[3]!.orderId)).toBe('revealed');
    expect(h.broadcasters.standard.sent).toHaveLength(0);
  });

  it('a Full Block Degent never shares a block: not with Large Degents before it, not with ones after it', async () => {
    const h = makeHarness();
    const a = await browserMintToPayment(h, { bytes: largeArt(1), recipientSeed: 1 });
    const full = await browserMintToPayment(h, { bytes: fullBlockArt(2), recipientSeed: 2 });
    const c = await browserMintToPayment(h, { bytes: largeArt(3), recipientSeed: 3 });
    expect(full.order.tier).toBe('fullblock');
    expect(full.order.quote!.revealWeight).toBeGreaterThan(3_500_000);
    fundCommit(h, a);
    fundCommit(h, full);
    fundCommit(h, c);
    await h.worker.tick();
    expect(await status(h, a.orderId)).toBe('revealed');
    expect(await status(h, full.orderId)).toBe('queued'); // never shares a block
    expect(await status(h, c.orderId)).toBe('queued'); // no overtaking: waits behind the Full Block Degent
    const pos = async (id: string) => ((await api(h, 'GET', `/v1/orders/${id}`)).body as Order).queue;
    expect(await pos(full.orderId)).toEqual({ lane: 'block', position: 2, etaMinutes: 20 });
    expect(await pos(c.orderId)).toEqual({ lane: 'block', position: 3, etaMinutes: 30 });
    // A new Large Degent quoted now is told slot 3 (it can share c's block), a new Full Block Degent slot 4.
    const d = await browserCreate(h, { bytes: largeArt(4), recipientSeed: 4 });
    expect(d.order.quote!.queuePosition).toBe(3);
    const e = await browserCreate(h, { bytes: fullBlockArt(7), recipientSeed: 7 });
    expect(e.order.quote!.queuePosition).toBe(4);
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, full.orderId)).toBe('revealed');
    expect(await status(h, c.orderId)).toBe('queued'); // a Large Degent does not join a Full Block Degent's block either
    expect((await api(h, 'GET', '/v1/queue')).body.block).toMatchObject({ inFlight: 1, waiting: 1 });
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, c.orderId)).toBe('revealed');
    expect(h.broadcasters.block.sent).toHaveLength(3);
  }, 30_000);

  it('a Full Block Degent alone in flight blocks even a tiny block-lane order until the block is mined', async () => {
    const h = makeHarness();
    const full = await browserMintToPayment(h, { bytes: fullBlockArt(5), recipientSeed: 5 });
    fundCommit(h, full);
    await h.worker.tick();
    expect(await status(h, full.orderId)).toBe('revealed');
    const heavy = await browserMintToPayment(h, { bytes: heavyStandardArt(6), recipientSeed: 6 });
    expect(heavy.order.tier).toBe('standard');
    expect(heavy.order.quote!.lane).toBe('block');
    expect(heavy.order.quote!.queuePosition).toBe(2);
    fundCommit(h, heavy);
    await h.worker.tick();
    expect(await status(h, heavy.orderId)).toBe('queued');
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, heavy.orderId)).toBe('revealed');
  }, 30_000);

  it('two heavy Standard Degents (block lane) share one block', async () => {
    const h = makeHarness();
    const a = await browserMintToPayment(h, { bytes: heavyStandardArt(1), recipientSeed: 1 });
    const b = await browserMintToPayment(h, { bytes: heavyStandardArt(2), recipientSeed: 2 });
    fundCommit(h, a);
    fundCommit(h, b);
    await h.worker.tick();
    expect(await status(h, a.orderId)).toBe('revealed');
    expect(await status(h, b.orderId)).toBe('revealed');
    expect(h.broadcasters.block.sent).toHaveLength(2);
    expect(h.broadcasters.standard.sent).toHaveLength(0);
  });

  it('standard lane: bounded concurrency', async () => {
    const h = makeHarness(); // standardConcurrency = 3
    const orders = [];
    for (let i = 0; i < 4; i++) orders.push(await browserMintToPayment(h, { recipientSeed: 10 + i }));
    for (const o of orders) fundCommit(h, o);
    await h.worker.tick();
    const st = await Promise.all(orders.map((o) => status(h, o.orderId)));
    expect(st.filter((s) => s === 'revealed')).toHaveLength(3);
    expect(st.filter((s) => s === 'queued')).toHaveLength(1);
    const q = await api(h, 'GET', '/v1/queue');
    expect(q.body.standard).toMatchObject({ waiting: 1, inFlight: 3, weightBudget: null, inFlightWeight: 0 });
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, orders[3]!.orderId)).toBe('revealed');
  });

  it('standard reveals never chain on an unconfirmed block-lane parent', async () => {
    const h = makeHarness();
    const blk = await browserMintToPayment(h, { bytes: largeArt(3), recipientSeed: 3 });
    fundCommit(h, blk);
    await h.worker.tick();
    expect(await status(h, blk.orderId)).toBe('revealed');
    const std = await browserMintToPayment(h, { recipientSeed: 4 });
    fundCommit(h, std);
    await h.worker.tick();
    expect(await status(h, std.orderId)).toBe('queued');
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, std.orderId)).toBe('revealed');
  });

  it('a parent UTXO whose value differs from parentValueSats pauses reveals instead of building an unspendable tx', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    // Operator error: the stored parent location points at a UTXO of the wrong value.
    await h.parents.initialise({ txid: h.parentTxid, vout: 0, value: h.parentValue + 1n, scriptHex: h.collectionScriptHex, confirmed: true, createdByLane: null }, { force: true });
    const rep = await h.worker.tick();
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued']);
    expect(await status(h, b.orderId)).toBe('queued');
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    expect(await h.parents.leasedBy()).toBeNull();
  });
});

describe('worker: broadcast failures and recovery', () => {
  it('retryable failure keeps the lease and rebroadcasts the same tx', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    h.broadcasters.standard.mode = 'retryable';
    await h.worker.tick();
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('revealing');
    expect(await h.parents.leasedBy()).toBe(b.orderId);
    expect(new Set(h.broadcasters.standard.sent).size).toBe(1);
    const rec = await h.store.get(b.orderId);
    expect(rec!.broadcastAttempts).toBe(2);
    h.broadcasters.standard.mode = 'ok';
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('revealed');
    expect(await h.parents.leasedBy()).toBeNull();
  });

  it('permanent rejection releases the lease and requeues', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    h.broadcasters.standard.mode = 'permanent';
    const rep = await h.worker.tick();
    expect(rep.transitions.map((t) => t.to)).toEqual(['paid', 'queued', 'revealing', 'queued']);
    expect(await h.parents.leasedBy()).toBeNull();
    expect((await h.parents.current())!.txid).toBe(h.parentTxid);
    h.broadcasters.standard.mode = 'ok';
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('revealed');
  });

  it('a reveal evicted from the mempool is re-pushed', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    const rec = await h.store.get(b.orderId);
    h.chain.evict(rec!.revealTxid!);
    await h.worker.tick();
    expect(h.broadcasters.standard.sent).toHaveLength(2);
    expect(await h.chain.getTx(rec!.revealTxid!)).not.toBeNull();
  });

  it('waits for the configured confirmations', async () => {
    const h = makeHarness({ settings: { confirmations: 2 } });
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('revealed');
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('confirmed');
  });

  it('an unreachable chain backend never crashes the tick', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    h.chain.down = true;
    const rep = await h.worker.tick();
    expect(rep.errors.length).toBeGreaterThan(0);
    expect(await status(h, b.orderId)).toBe('awaiting_payment');
  });

  it('emits one degent.mint.order.* event per transition with previousStatus', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    const evs = h.events.orderEvents.filter((e) => e.orderId === b.orderId);
    expect(evs.map((e) => [e.previousStatus, e.status])).toEqual([
      [null, 'awaiting_content'],
      ['awaiting_content', 'reviewing'],
      ['reviewing', 'approved'],
      ['approved', 'awaiting_payment'],
      ['awaiting_payment', 'paid'],
      ['paid', 'queued'],
      ['queued', 'revealing'],
      ['revealing', 'revealed'],
    ]);
    expect(new Set(evs.map((e) => e.eventId)).size).toBe(evs.length);
    expect(evs.at(-1)!.inscriptionId).toMatch(/^[0-9a-f]{64}i0$/);
  });
});
