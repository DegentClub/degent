import { createEvent } from '@bsh/events';
import { describe, expect, it } from 'vitest';
import {
  ConsoleEmailSender,
  EmailChannel,
  HttpTelegramClient,
  PermanentEmailError,
  TelegramChannel,
  validateWebhookTarget,
  verifyWebhookSignature,
  WebhookChannel,
  type FetchLike,
  type Notification,
} from '../src/index.js';

const event = createEvent({ source: 'urn:bsh:degent-mint', type: 'collection.minted', id: 'e-1', subject: 'degents', data: { inscriptionId: 'abc' } });
const note = (channel: string, target: string, attempt = 1): Notification => ({
  event,
  subscription: { id: 'sub-1', subscriberId: 'acme', channel, target, topics: ['collection.*'] },
  idempotencyKey: 'key-1',
  attempt,
});

function fakeFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> } | Error>) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200 };
    if (r instanceof Error) throw r;
    return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? '' };
  };
  return { fetch, calls };
}

describe('WebhookChannel', () => {
  const T = 1_790_000_000;
  it('POSTs the signed envelope with idempotency and event headers', async () => {
    const { fetch, calls } = fakeFetch([{ status: 204 }]);
    const ch = new WebhookChannel({ fetch, secrets: async () => 'whsec', nowSec: () => T });
    expect(await ch.send(note('webhook', 'https://hooks.example.com/bsh'))).toEqual({ ok: true, status: 204 });
    const { url, init } = calls[0]!;
    expect(url).toBe('https://hooks.example.com/bsh');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({
      'Idempotency-Key': 'key-1',
      'Bsh-Event-Id': 'e-1',
      'Bsh-Event-Type': 'collection.minted',
      'Bsh-Delivery-Attempt': '1',
      'Content-Type': 'application/cloudevents+json; charset=utf-8',
    });
    expect(JSON.parse(init.body)).toEqual(event);
    // the receiver-side helper accepts exactly what was sent
    expect(verifyWebhookSignature(init.body, init.headers['Bsh-Signature'], 'whsec', 300, T)).toEqual({ ok: true, timestamp: T });
  });

  it.each([
    [{ status: 500 }, true],
    [{ status: 503, headers: { 'retry-after': '120' } }, true],
    [{ status: 429 }, true],
    [{ status: 408 }, true],
    [{ status: 400 }, false],
    [{ status: 410 }, false],
    [{ status: 301 }, false],
    [new TypeError('fetch failed'), true],
  ])('classifies %o as retryable=%s', async (resp, retryable) => {
    const { fetch } = fakeFetch([resp]);
    const r = await new WebhookChannel({ fetch, secrets: async () => 's', nowSec: () => T }).send(note('webhook', 'https://h.example.com'));
    expect(r).toMatchObject({ ok: false, retryable });
    if (!(resp instanceof Error) && 'headers' in resp) expect(r).toMatchObject({ retryAfterMs: 120_000 });
  });

  it('validates targets (https only, no credentials, no private literal hosts)', async () => {
    expect(() => validateWebhookTarget('http://h.example.com')).toThrow(/https/);
    expect(() => validateWebhookTarget('https://u:p@h.example.com')).toThrow(/credentials/);
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '[::1]'])
      expect(() => validateWebhookTarget(`https://${h}/x`), h).toThrow(/private/);
    expect(() => validateWebhookTarget('not a url')).toThrow();
    expect(validateWebhookTarget('http://localhost:3000/h', { allowHttp: true, allowPrivateHosts: true }).port).toBe('3000');
    const { fetch, calls } = fakeFetch([]);
    const r = await new WebhookChannel({ fetch, secrets: async () => 's' }).send(note('webhook', 'https://169.254.169.254/latest'));
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(calls).toEqual([]);
  });

  it('secret resolution failure is permanent and nothing is sent', async () => {
    const { fetch, calls } = fakeFetch([]);
    const r = await new WebhookChannel({ fetch, secrets: async () => { throw new Error('no secret'); } }).send(note('webhook', 'https://h.example.com'));
    expect(r).toEqual({ ok: false, retryable: false, error: 'no secret' });
    expect(calls).toEqual([]);
  });
});

describe('EmailChannel', () => {
  it('renders and sends through the port with the idempotency key', async () => {
    const lines: string[] = [];
    const sender = new ConsoleEmailSender((l) => lines.push(l));
    const ch = new EmailChannel(sender);
    expect(await ch.send(note('email', 'ops@example.com'))).toEqual({ ok: true });
    expect(sender.sent[0]).toMatchObject({ to: 'ops@example.com', subject: '[bsh] collection.minted degents', idempotencyKey: 'key-1' });
    expect(sender.sent[0]!.text).toContain('"inscriptionId": "abc"');
    expect(lines[0]).toContain('[email:dev] to=ops@example.com');
    expect(() => ch.validateTarget('nope')).toThrow();
  });
  it('maps PermanentEmailError to non-retryable', async () => {
    const ch = new EmailChannel({ send: async () => { throw new PermanentEmailError('suppressed'); } });
    expect(await ch.send(note('email', 'a@b.co'))).toMatchObject({ ok: false, retryable: false });
    const ch2 = new EmailChannel({ send: async () => { throw new Error('smtp timeout'); } });
    expect(await ch2.send(note('email', 'a@b.co'))).toMatchObject({ ok: false, retryable: true });
  });
});

describe('TelegramChannel + HttpTelegramClient', () => {
  it('calls sendMessage on the Bot API', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: '{"ok":true,"result":{}}' }]);
    const ch = new TelegramChannel(new HttpTelegramClient({ botToken: '123:SECRET', fetch }));
    expect(await ch.send(note('telegram', '-1001234'))).toEqual({ ok: true, status: 200 });
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123:SECRET/sendMessage');
    const body = JSON.parse(calls[0]!.init.body);
    expect(body).toMatchObject({ chat_id: '-1001234', disable_web_page_preview: true });
    expect(body.text).toMatch(/^\[bsh\] collection\.minted degents\n\ncollection\.minted/);
  });
  it('honours retry_after on 429, treats 403 as permanent, and never leaks the token', async () => {
    const { fetch } = fakeFetch([
      { status: 429, body: '{"ok":false,"description":"Too Many Requests","parameters":{"retry_after":7}}' },
      { status: 403, body: '{"ok":false,"description":"Forbidden: bot was blocked by the user"}' },
      new Error('connect ECONNREFUSED https://api.telegram.org/bot123:SECRET/sendMessage'),
    ]);
    const client = new HttpTelegramClient({ botToken: '123:SECRET', fetch });
    expect(await client.sendMessage('1', 'x')).toMatchObject({ ok: false, retryable: true, retryAfterMs: 7_000 });
    expect(await client.sendMessage('1', 'x')).toMatchObject({ ok: false, retryable: false, status: 403 });
    const r = await client.sendMessage('1', 'x');
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
  it('validates chat ids', () => {
    const ch = new TelegramChannel({ sendMessage: async () => ({ ok: true }) });
    expect(() => ch.validateTarget('-1001234')).not.toThrow();
    expect(() => ch.validateTarget('@bsh_alerts')).not.toThrow();
    expect(() => ch.validateTarget('https://t.me/x')).toThrow();
  });
});
