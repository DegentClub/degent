import { describe, expect, it } from 'vitest';
import type { Order } from '@bsh/degent-mint-sdk';
import { api, browserCreate, browserMintToPayment, browserUpload, fundCommit, makeHarness, regtestAddress, type Harness } from './fakes/harness.js';
import { png } from './fakes/images.js';

const status = async (h: Harness, id: string) => ((await api(h, 'GET', `/v1/orders/${id}`)).body as Order).status;
const blockArt = (seed: number) => png(1000 + seed, 1000, 400_000);

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
    h.settings.collection.serviceFeeSats = { standard: 5000, block: 5000 };
    const b = await browserMintToPayment(h);
    expect(b.order.quote!.totalSats).toBe(b.order.quote!.commitValueSats + 5000);
    fundCommit(h, b);
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('rescue_available');
    expect(h.broadcasters.standard.sent).toHaveLength(0);
  });
});

describe('worker: lanes', () => {
  it('block lane: one reveal in flight per block', async () => {
    const h = makeHarness();
    const a = await browserMintToPayment(h, { bytes: blockArt(1), recipientSeed: 1 });
    const b = await browserMintToPayment(h, { bytes: blockArt(2), recipientSeed: 2 });
    fundCommit(h, a);
    fundCommit(h, b);
    await h.worker.tick();
    expect(await status(h, a.orderId)).toBe('revealed');
    expect(await status(h, b.orderId)).toBe('queued');
    const queued = (await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order;
    expect(queued.queue).toEqual({ lane: 'block', position: 2, etaMinutes: 20 });
    await h.worker.tick();
    expect(await status(h, b.orderId)).toBe('queued');
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, a.orderId)).toBe('confirmed');
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
    expect(q.body.standard).toMatchObject({ waiting: 1, inFlight: 3 });
    h.chain.mine();
    await h.worker.tick();
    expect(await status(h, orders[3]!.orderId)).toBe('revealed');
  });

  it('standard reveals never chain on an unconfirmed block-lane parent', async () => {
    const h = makeHarness();
    const blk = await browserMintToPayment(h, { bytes: blockArt(3), recipientSeed: 3 });
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
    const evs = h.events.events.filter((e) => e.orderId === b.orderId);
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
