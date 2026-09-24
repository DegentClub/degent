/**
 * Artist notifications (ADR-0012) through @bsh/notify's real WebhookChannel / TelegramChannel over fake
 * transports: targets on the profile, the secret returned once, what is sent when, the signature, and the
 * rule that a failed notification never fails the request that triggered it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { verifyWebhookSignature } from '@bsh/notify';
import { notificationType, recipientKey } from '../src/adapters/bsh-artist-notifier.js';
import { api, makeHarness, signIn, submit, wallet, type Harness, type Session } from './fakes/harness.js';
import { FakeVisionReview, needsHuman, reject } from './fakes/misc.js';
import { jpeg } from './fakes/images.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-studio.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
((addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats)(ajv);
ajv.addSchema(openapi, 'studio.yaml');
const validEnvelope = (v: unknown) => {
  const f = ajv.getSchema('studio.yaml#/components/schemas/ArtistNotificationEnvelope')!;
  return f(v) ? [] : [ajv.errorsText(f.errors)];
};

const HOOK = 'https://hooks.example.com/degent';
const setNotify = (h: Harness, s: Session, notify: unknown) => api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { notify } });

async function artistWithWebhook(h: Harness, seed: number, extra: Record<string, unknown> = {}) {
  const s = await signIn(h, seed);
  const r = await setNotify(h, s, { webhookUrl: HOOK, ...extra });
  expect(r.status).toBe(200);
  return { s, secret: r.body.notifyWebhookSecret as string };
}

const royalty = (artworkId: string, i: number, extra: Record<string, unknown> = {}) => ({
  orderId: `dgt_${i}`,
  artworkId,
  minterAddress: wallet(800 + i).address,
  royaltySats: 12_345,
  fundingTxid: 'ab'.repeat(32),
  vout: 1,
  at: '2026-09-24T13:00:00.000Z',
  ...extra,
});

describe('PUT /v1/artists/me notify', () => {
  it('registers a webhook: the signing secret is returned once, the profile shows only that it exists', async () => {
    const h = makeHarness();
    const s = await signIn(h, 1);
    expect((await api(h, 'GET', '/v1/artists/me', { token: s.token })).body.notify).toEqual({ webhookUrl: null, telegramChatId: null, webhookSecretSet: false });
    const r = await setNotify(h, s, { webhookUrl: HOOK });
    expect(r.status).toBe(200);
    expect(r.body.notify).toEqual({ webhookUrl: HOOK, telegramChatId: null, webhookSecretSet: true });
    expect(r.body.notifyWebhookSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const me = await api(h, 'GET', '/v1/artists/me', { token: s.token });
    expect(me.body).not.toHaveProperty('notifyWebhookSecret');
    expect(JSON.stringify(me.body)).not.toContain(r.body.notifyWebhookSecret);
    // changing the URL or the display name keeps the secret and does not show it again
    const moved = await setNotify(h, s, { webhookUrl: 'https://hooks.example.com/v2' });
    expect(moved.body).not.toHaveProperty('notifyWebhookSecret');
    expect((await h.artists.get(s.address))!.notify!.webhookSecret).toBe(r.body.notifyWebhookSecret);
    const named = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: 'Hooked' } });
    expect(named.body).toMatchObject({ displayName: 'Hooked', notify: { webhookUrl: 'https://hooks.example.com/v2', webhookSecretSet: true } });
  });

  it('rotates on request, deletes the secret with the webhook, and notify: null clears everything', async () => {
    const h = makeHarness();
    const { s, secret } = await artistWithWebhook(h, 2, { telegramChatId: '123456789' });
    const rotated = await setNotify(h, s, { rotateWebhookSecret: true });
    expect(rotated.body.notifyWebhookSecret).toMatch(/^whsec_/);
    expect(rotated.body.notifyWebhookSecret).not.toBe(secret);
    const cleared = await setNotify(h, s, { webhookUrl: null });
    expect(cleared.body.notify).toEqual({ webhookUrl: null, telegramChatId: '123456789', webhookSecretSet: false });
    expect((await h.artists.get(s.address))!.notify!.webhookSecret).toBeNull();
    const again = await setNotify(h, s, { webhookUrl: HOOK });
    expect(again.body.notifyWebhookSecret).toMatch(/^whsec_/);
    const none = await setNotify(h, s, null);
    expect(none.body.notify).toEqual({ webhookUrl: null, telegramChatId: null, webhookSecretSet: false });
  });

  it('validates targets with @bsh/notify: https only, no credentials, no private hosts; telegram chat ids', async () => {
    const h = makeHarness();
    const s = await signIn(h, 3);
    const bad: unknown[] = [
      { webhookUrl: 'http://hooks.example.com/x' },
      { webhookUrl: 'https://user:pw@hooks.example.com/x' },
      { webhookUrl: 'https://127.0.0.1/x' },
      { webhookUrl: 'https://localhost:8080/x' },
      { webhookUrl: 'https://10.0.0.5/x' },
      { webhookUrl: 'https://192.168.1.2/x' },
      { webhookUrl: 'not a url' },
      { webhookUrl: `https://hooks.example.com/${'a'.repeat(2048)}` },
      { webhookUrl: 5 },
      { webhookUrl: '' },
      { telegramChatId: 'abc' },
      { telegramChatId: '@ab' },
      { telegramChatId: 12345 },
      { rotateWebhookSecret: true },
      { rotateWebhookSecret: 'yes' },
      { email: 'a@b.c' },
      'https://hooks.example.com',
    ];
    for (const notify of bad) {
      const r = await setNotify(h, s, notify);
      expect(r.status, JSON.stringify(notify)).toBe(422);
      expect(r.body.error.code).toBe('validation_failed');
    }
    expect((await setNotify(h, s, { telegramChatId: '-1001234567890' })).status).toBe(200);
    expect((await setNotify(h, s, { telegramChatId: '@degent_club' })).status).toBe(200);
    expect((await h.artists.get(s.address))!.notify).toEqual({ webhookUrl: null, telegramChatId: '@degent_club', webhookSecret: null });
  });

  it('without a Telegram bot, telegram targets are refused and the config says webhook only', async () => {
    const h = makeHarness({ telegram: false });
    const s = await signIn(h, 4);
    const r = await setNotify(h, s, { telegramChatId: '123456789' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/telegram notifications are not enabled/);
    expect((await api(h, 'GET', '/v1/config')).body.notifyChannels).toEqual(['webhook']);
    expect((await api(h, 'GET', '/v1/config', {})).status).toBe(200);
    const full = makeHarness();
    expect((await api(full, 'GET', '/v1/config')).body.notifyChannels).toEqual(['webhook', 'telegram']);
  });

  it('without a notifier nothing can be registered', async () => {
    const h = makeHarness({ noNotifier: true });
    const s = await signIn(h, 5);
    const r = await setNotify(h, s, { webhookUrl: HOOK });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/not enabled/);
    expect((await api(h, 'GET', '/v1/config')).body.notifyChannels).toEqual([]);
  });
});

describe('what the artist is told', () => {
  it('approved: one signed webhook with the CloudEvents envelope, verifiable with the secret; and a Telegram message', async () => {
    const h = makeHarness();
    const { s, secret } = await artistWithWebhook(h, 11, { telegramChatId: '42424242' });
    const sub = await submit(h, s, { title: 'Gentleman No. 7' });
    await h.service.notificationsIdle();
    expect(h.webhooks.received).toHaveLength(1);
    const w = h.webhooks.received[0]!;
    expect(w.url).toBe(HOOK);
    expect(w.json).toMatchObject({
      specversion: '1.0',
      source: 'urn:bsh:degent-studio',
      type: notificationType(s.address, 'artwork.approved'),
      id: `${sub.artworkId}:3`,
      subject: sub.artworkId,
      data: { kind: 'artwork.approved', artist: s.address, artworkId: sub.artworkId, title: 'Gentleman No. 7', message: "Your Degent 'Gentleman No. 7' was approved and hangs in the gallery." },
    });
    expect(w.json.type).toBe(`degent.studio.notify.${recipientKey(s.address)}.artwork.approved`);
    expect(validEnvelope(w.json)).toEqual([]);
    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    expect(verifyWebhookSignature(w.body, w.headers['Bsh-Signature'], secret, 300, nowSec)).toEqual({ ok: true, timestamp: nowSec });
    expect(verifyWebhookSignature(w.body, w.headers['Bsh-Signature'], 'whsec_wrong', 300, nowSec)).toMatchObject({ ok: false });
    expect(w.headers['Idempotency-Key']).toMatch(/^[0-9a-f]{64}$/);
    expect(w.headers['Bsh-Event-Type']).toBe(w.json.type);
    expect(h.telegram.sent).toEqual([{ chatId: '42424242', text: "degent.club\n\nYour Degent 'Gentleman No. 7' was approved and hangs in the gallery." }]);
  });

  it('rejected (with reasons) and needs-human, including the appeal wait', async () => {
    const vision = new FakeVisionReview(reject('rule 2: no bow tie', 'rule 4: placard reads DEGNET'));
    const h = makeHarness({ vision });
    const { s } = await artistWithWebhook(h, 12);
    const sub = await submit(h, s, { title: 'No Tie' });
    await h.service.notificationsIdle();
    expect(h.webhooks.received.map((w) => w.json.data)).toEqual([
      expect.objectContaining({ kind: 'artwork.rejected', reasons: ['rule 2: no bow tie', 'rule 4: placard reads DEGNET'], message: "Your Degent 'No Tie' was rejected: rule 2: no bow tie; rule 4: placard reads DEGNET." }),
    ]);
    await api(h, 'POST', `/v1/artworks/${sub.artworkId}/appeal`, { token: s.token, json: { message: 'It is a bow tie.' } });
    await h.service.notificationsIdle();
    expect(h.webhooks.received.at(-1)!.json.data).toMatchObject({ kind: 'artwork.needs_human', message: "Your appeal for your Degent 'No Tie' is waiting for a house reviewer." });
    await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'reject', reasons: ['rule 2: that is a necktie'] } });
    await h.service.notificationsIdle();
    expect(h.webhooks.received.at(-1)!.json.data).toMatchObject({ kind: 'artwork.rejected', reasons: ['rule 2: that is a necktie'] });
    vision.result = needsHuman();
    const waiting = await submit(h, s, { title: 'Waiting', bytes: jpeg(1024, 1024, 210_000, 7) });
    await h.service.notificationsIdle();
    expect(h.webhooks.received.at(-1)!.json.data).toMatchObject({ kind: 'artwork.needs_human', artworkId: waiting.artworkId, message: "Your Degent 'Waiting' is waiting for a house reviewer." });
    for (const w of h.webhooks.received) expect(validEnvelope(w.json)).toEqual([]);
    // submitted and delisted are not notified
    expect(h.webhooks.received.map((w) => w.json.data.kind)).toEqual(['artwork.rejected', 'artwork.needs_human', 'artwork.rejected', 'artwork.needs_human']);
  });

  it('royalty recorded: "minted, edition #n, <sats> sats paid in <txid>:<vout>", once per order', async () => {
    const h = makeHarness();
    const { s } = await artistWithWebhook(h, 13, { telegramChatId: '@degent_artist' });
    const sub = await submit(h, s, { title: 'Gentleman No. 1' });
    await h.service.notificationsIdle();
    h.webhooks.received.length = 0;
    h.telegram.sent.length = 0;
    const post = (json: unknown) => api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json });
    expect((await post(royalty(sub.artworkId, 1, { edition: 3 }))).status).toBe(201);
    expect((await post(royalty(sub.artworkId, 1, { edition: 3 }))).status).toBe(200); // replay: no second notification
    await h.service.notificationsIdle();
    const msg = `Your Degent 'Gentleman No. 1' was minted, edition #3, 12345 sats paid in ${'ab'.repeat(32)}:1`;
    expect(h.webhooks.received).toHaveLength(1);
    expect(h.webhooks.received[0]!.json).toMatchObject({
      id: 'royalty:dgt_1',
      data: { kind: 'royalty.recorded', orderId: 'dgt_1', edition: 3, royaltySats: 12_345, fundingTxid: 'ab'.repeat(32), vout: 1, message: msg },
    });
    expect(validEnvelope(h.webhooks.received[0]!.json)).toEqual([]);
    expect(h.telegram.sent).toEqual([{ chatId: '@degent_artist', text: `degent.club\n\n${msg}` }]);
    // without an edition the sentence omits it
    await post(royalty(sub.artworkId, 2));
    await h.service.notificationsIdle();
    expect(h.webhooks.received.at(-1)!.json.data.message).toBe(`Your Degent 'Gentleman No. 1' was minted, 12345 sats paid in ${'ab'.repeat(32)}:1`);
  });

  it('artists without targets are not notified; other artists never receive someone else\'s notification', async () => {
    const h = makeHarness();
    const quiet = await signIn(h, 14);
    const { s: loud } = await artistWithWebhook(h, 15);
    await submit(h, quiet);
    await h.service.notificationsIdle();
    expect(h.webhooks.received).toHaveLength(0);
    await submit(h, loud, { bytes: jpeg(1024, 1024, 210_000, 8) });
    await h.service.notificationsIdle();
    expect(h.webhooks.received.map((w) => w.json.data.artist)).toEqual([loud.address]);
  });

  it('a target removed before delivery is not used', async () => {
    const h = makeHarness();
    const { s } = await artistWithWebhook(h, 16);
    await setNotify(h, s, { webhookUrl: null, telegramChatId: '5555555' });
    await submit(h, s);
    await h.service.notificationsIdle();
    expect(h.webhooks.received).toHaveLength(0);
    expect(h.telegram.sent).toHaveLength(1);
  });
});

describe('a failed notification never fails the triggering request', () => {
  it('webhook 500 / network error / telegram failure: the upload, the review and the royalty still succeed; retries follow', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman()) });
    const { s } = await artistWithWebhook(h, 21, { telegramChatId: '777777' });
    h.webhooks.status = 500;
    h.telegram.result = { ok: false, retryable: false, status: 403, error: 'bot was blocked by the user' };
    const sub = await submit(h, s);
    expect(sub.artwork.status).toBe('reviewing');
    h.webhooks.fail = new Error('ECONNREFUSED');
    const reviewed = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    expect(reviewed.status).toBe(200);
    const rec = await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: royalty(sub.artworkId, 9, { edition: 1 }) });
    expect(rec.status).toBe(201);
    await h.service.notificationsIdle();
    expect(h.notifier!.notifier.failed.map((f) => f.error)).toContain('bot was blocked by the user');
    // the webhook is retried with backoff on the notifier's clock and eventually delivered
    h.webhooks.fail = null;
    h.webhooks.status = 200;
    expect(h.notifier!.notifier.pendingRetries).toBeGreaterThan(0);
    await h.notifyClock.advance(60 * 60 * 1000);
    expect(h.webhooks.received.map((w) => w.json.data.kind).sort()).toEqual(['artwork.approved', 'artwork.needs_human', 'royalty.recorded']);
    // the needs-human webhook was answered 500 once, then acknowledged on a retry with the same idempotency key
    const tries = h.webhooks.attempts.filter((w) => w.json.data.kind === 'artwork.needs_human');
    expect(tries.map((w) => w.headers['Bsh-Delivery-Attempt'])).toEqual(['1', '2']);
    expect(new Set(tries.map((w) => w.headers['Idempotency-Key'])).size).toBe(1);
  });

  it('a notifier that throws is logged and swallowed', async () => {
    const h = makeHarness();
    const { s } = await artistWithWebhook(h, 22);
    h.notifier!.notify = async () => {
      throw new Error('notifier exploded');
    };
    const sub = await submit(h, s);
    expect(sub.artwork.status).toBe('approved');
    await h.service.notificationsIdle();
  });
});
