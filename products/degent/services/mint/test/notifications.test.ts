/**
 * Order notifications: POST /v1/orders/{id}/subscriptions (order-token auth, validation, idempotency, limits)
 * and delivery through @bsh/notify on member_review, declined, rescue_available and delivered, with the notify
 * fakes (ConsoleEmailSender keeps what it "sent", FakeTelegram records messages, ManualClock drives retries).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Order, OrderStatusEvent } from '@bsh/degent-mint-sdk';
import { api, browserMintToPayment, castVote, fundAndApprove, fundToReview, makeHarness, MEMBER_SEEDS, type Harness } from './fakes/harness.js';
import { blockHeightOf, renderOrderNotification, subscriptionId } from '../src/application/notification-service.js';
import { buildRuntime } from '../src/wiring.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/application/logger.js';

const getOrder = async (h: Harness, id: string): Promise<Order> => (await api(h, 'GET', `/v1/orders/${id}`)).body;
const subscribe = (h: Harness, id: string, token: string | undefined, json: unknown) =>
  api(h, 'POST', `/v1/orders/${id}/subscriptions`, { json, ...(token ? { token } : {}) });

describe('POST /v1/orders/{id}/subscriptions', () => {
  it('needs the order token, validates the channel and address, and is idempotent per (order, channel, address)', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);

    expect((await subscribe(h, b.orderId, undefined, { channel: 'email', address: 'gent@example.com' })).status).toBe(401);
    expect((await subscribe(h, b.orderId, 'x'.repeat(40), { channel: 'email', address: 'gent@example.com' })).status).toBe(403);
    expect((await subscribe(h, 'dgt_nope', b.token, { channel: 'email', address: 'gent@example.com' })).status).toBe(404);
    for (const bad of [
      { channel: 'sms', address: '+15550100' },
      { channel: 'email', address: 'not-an-email' },
      { channel: 'telegram_chat', address: 'bob smith' },
      { channel: 'email', address: '' },
      { channel: 'email', address: 'gent@example.com', extra: 1 },
    ]) {
      const r = await subscribe(h, b.orderId, b.token, bad);
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.body.error.code).toBe('validation_failed');
    }

    const first = await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'gent@example.com' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      orderId: b.orderId,
      channel: 'email',
      address: 'gent@example.com',
      events: ['member_review', 'declined', 'rescue_available', 'delivered'],
    });
    expect(first.body.id).toBe(subscriptionId(b.orderId, 'email', 'gent@example.com'));
    const again = await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'Gent@Example.com' });
    expect(again.body.id).toBe(first.body.id);

    expect((await subscribe(h, b.orderId, b.token, { channel: 'telegram_chat', address: '123456789' })).status).toBe(201);
    expect((await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'butler@example.com' })).status).toBe(201);
    const fourth = await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'valet@example.com' });
    expect(fourth.status).toBe(422);
    expect(fourth.body.error.message).toMatch(/at most 3/);

    // The address never leaks into the public order view.
    expect(JSON.stringify(await getOrder(h, b.orderId))).not.toContain('gent@example.com');
  });

  it('answers 503 channel_unavailable for a channel the deployment has not configured', async () => {
    const h = makeHarness({ noTelegram: true });
    await h.ready;
    const b = await browserMintToPayment(h);
    const r = await subscribe(h, b.orderId, b.token, { channel: 'telegram_chat', address: '123456789' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('channel_unavailable');
  });
});

describe('order notifications via @bsh/notify', () => {
  it('member_review: "your Degent is with the club", by email and Telegram; silent for every other status', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);
    await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'gent@example.com' });
    await subscribe(h, b.orderId, b.token, { channel: 'telegram_chat', address: '123456789' });
    await fundToReview(h, b); // paid -> confirming -> member_review
    await vi.waitFor(() => expect(h.email.sent).toHaveLength(1));
    expect(h.email.sent[0]).toMatchObject({ to: 'gent@example.com', subject: 'Your Degent is with the club' });
    expect(h.email.sent[0]!.text).toContain(`https://degent.club/track/${b.orderId}`);
    expect(h.email.sent[0]!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    await vi.waitFor(() => expect(h.telegram.sent).toHaveLength(1));
    expect(h.telegram.sent[0]).toMatchObject({ chatId: '123456789' });
    expect(h.telegram.sent[0]!.text).toMatch(/^Your Degent is with the club/);
  });

  it('declined: the members said no; the message points at self-rescue with the recovery passphrase', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);
    await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'gent@example.com' });
    await fundToReview(h, b);
    for (const seed of MEMBER_SEEDS.slice(0, h.settings.approval.declineQuorum)) await castVote(h, seed, b.orderId, 'decline');
    expect((await getOrder(h, b.orderId)).status).toBe('declined');
    await vi.waitFor(() => expect(h.email.sent.map((m) => m.subject)).toEqual(['Your Degent is with the club', 'The members declined your Degent']));
    expect(h.email.sent[1]!.text).toMatch(/recovery passphrase/);
  });

  it('delivered: "Degent #N joined the club, block X"', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);
    await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'gent@example.com' });
    await fundAndApprove(h, b);
    await h.worker.tick(); // revealing -> revealed
    h.chain.mine();
    await h.worker.tick(); // confirmed (block N)
    const o = await getOrder(h, b.orderId);
    h.chain.inscriptions.set(o.inscriptionId!, b.bytes);
    await h.worker.tick(); // verified -> delivered
    const done = await getOrder(h, b.orderId);
    expect(done.status).toBe('delivered');
    const height = blockHeightOf(done);
    expect(height).not.toBeNull();
    await vi.waitFor(() => expect(h.email.sent).toHaveLength(2));
    expect(h.email.sent[1]!.subject).toBe(`Degent #${done.degentNumber} joined the club, block ${height}`);
    expect(h.email.sent[1]!.text).toContain(`https://degent.club/collection/${done.degentNumber}`);
    // Terminal: no new subscriptions.
    const late = await subscribe(h, b.orderId, b.token, { channel: 'email', address: 'late@example.com' });
    expect(late.status).toBe(409);
  });

  it('rescue_available, redelivery de-duplication and retries with backoff', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);
    await subscribe(h, b.orderId, b.token, { channel: 'telegram_chat', address: '123456789' });
    const event: OrderStatusEvent = {
      type: 'degent.mint.order.rescue_available',
      eventId: `${b.orderId}:99`,
      orderId: b.orderId,
      network: 'regtest',
      status: 'rescue_available',
      previousStatus: 'queued',
      at: new Date(0).toISOString(),
      lane: 'standard',
    };
    h.telegram.failNext = 1;
    const first = await h.notifications.handle(event);
    expect(first.map((o) => o.status)).toEqual(['retrying']);
    expect(h.telegram.sent).toHaveLength(0);
    await h.retryClock.runAll();
    expect(h.telegram.sent).toHaveLength(1);
    expect(h.telegram.sent[0]!.text).toMatch(/^Self-rescue is available for your Degent/);
    // The bus redelivers the same event: the delivery log suppresses a second message.
    const again = await h.notifications.handle(event);
    expect(again.map((o) => o.status)).toEqual(['duplicate']);
    expect(h.telegram.sent).toHaveLength(1);
    // Non-notifying statuses do nothing at all.
    expect(await h.notifications.handle({ ...event, type: 'degent.mint.order.queued', status: 'queued', eventId: `${b.orderId}:100` })).toEqual([]);
  });
});

describe('copy and wiring', () => {
  it('renders the delivered message without a number for a rescued (parent-less) inscription', () => {
    const order = {
      degentNumber: null,
      rescued: true,
      timeline: [{ status: 'confirmed', at: '2026-09-24T00:00:00.000Z', detail: 'block 912345' }],
    } as unknown as Order;
    const m = renderOrderNotification({ status: 'delivered', orderId: 'dgt_x' }, order, 'https://degent.club/');
    expect(m.subject).toBe('Your inscription landed, block 912345');
    expect(m.text).toContain('https://degent.club/track/dgt_x');
  });

  it('buildRuntime wires notifications (console email on regtest, telegram only with a token)', () => {
    const cfg = loadConfig({ NETWORK: 'regtest' });
    expect(cfg.notify).toEqual({ siteUrl: 'https://degent.club', email: 'console', telegramBotToken: null });
    const rt = buildRuntime(cfg, silentLogger);
    expect(rt.notifications.availableChannels()).toEqual(['email']);
    rt.close();
    expect(() => loadConfig({ NETWORK: 'regtest', NOTIFY_EMAIL: 'smtp' })).toThrow(/NOTIFY_EMAIL/);
    expect(() => loadConfig({ NETWORK: 'regtest', TELEGRAM_BOT_TOKEN: 'nope' })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
