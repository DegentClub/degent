/**
 * p5.1 / p5.3 production configuration: SIGNER=remote is the only mainnet signer, stores are durable off
 * regtest, AMQP_URL wires the platform bus through @bsh/events connectAmqpBus (startup health check,
 * graceful shutdown, /v1/health `bus`), mainnet refuses to start without it and signet/testnet warn.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { p2tr } from '@scure/btc-signer';
import { generateApiKey, hashApiKey } from '@bsh/edge';
import { InMemoryBus, type EventBus as PlatformBus, type EventEnvelope } from '@bsh/events';
import { networkParams } from '@bsh/inscription';
import { sha256Hex, tierForSize, type OrderStatusEvent, type RoyaltyPaidEvent } from '@bsh/degent-mint-sdk';
import { ConfigError, loadConfig, type MintConfig } from '../src/config.js';
import { buildRuntime, redactUrl, startRuntime, StartupError } from '../src/wiring.js';
import { BridgedEventBus } from '../src/adapters/platform-event-bus.js';
import { MemoryEventBus } from '../src/adapters/system.js';
import { silentLogger, type Logger } from '../src/application/logger.js';
import { PARENT_KEY, regtestAddress, standardArt } from './fakes/harness.js';
import { FakeBroker } from './fakes/amqplib.js';
import { makeSignerService, SIGNER_KEY_ID } from './fakes/remote-signer.js';

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
};

const addr = (net: 'mainnet' | 'testnet' | 'regtest', key = PARENT_KEY) => p2tr(schnorr.getPublicKey(key), undefined, networkParams(net)).address!;
const dir = mkdtempSync(join(tmpdir(), 'degent-prod-cfg-'));
const liveKey = generateApiKey('live').key;
const testKey = generateApiKey('test').key;

const mainnetEnv = {
  NETWORK: 'mainnet',
  DATABASE_PATH: join(dir, 'mainnet.db'),
  CONTENT_DIR: join(dir, 'content-mainnet'),
  ESPLORA_URL: 'https://mempool.space/api',
  ORD_URL: 'https://ord.example',
  LIBRE_RPC_URL: 'http://10.0.0.1:8332',
  PARENT_INSCRIPTION_ID: `${'a'.repeat(64)}i0`,
  COLLECTION_ADDRESS: addr('mainnet'),
  REVEAL_ENCRYPTION_KEY: '44'.repeat(32),
  SIGNER: 'remote',
  SIGNER_URL: 'http://signer.internal:3060',
  SIGNER_API_KEY: liveKey,
  SIGNER_KEY_ID: 'degent-parent',
  AMQP_URL: 'amqps://degent-mint:s3cret@rabbit.internal:5671/bsh',
};

const testnetEnv = {
  NETWORK: 'testnet',
  DATABASE_PATH: join(dir, 'testnet.db'),
  CONTENT_DIR: join(dir, 'content-testnet'),
  ESPLORA_URL: 'https://mempool.space/testnet4/api',
  ORD_URL: 'https://ord-testnet.example',
  PARENT_INSCRIPTION_ID: `${'a'.repeat(64)}i0`,
  COLLECTION_ADDRESS: addr('testnet'),
  REVEAL_ENCRYPTION_KEY: '44'.repeat(32),
};

describe('config: SIGNER=remote (p5.1)', () => {
  it('mainnet starts with the remote signer and the bus', () => {
    const c = loadConfig(mainnetEnv);
    expect(c.signer).toBe('remote');
    expect(c.remoteSigner).toEqual({ url: 'http://signer.internal:3060', apiKey: liveKey, keyId: 'degent-parent', timeoutMs: 10_000, retries: 2 });
    expect(c.bus).toEqual({ url: mainnetEnv.AMQP_URL, exchange: 'bsh.events', connectTimeoutMs: 10_000 });
    expect(c.databasePath).toBe(mainnetEnv.DATABASE_PATH);
    expect(c.adminApiKeyEnvironment).toBe('live');
  });

  it('mainnet keeps refusing the in-memory signer; kms is retired with a pointer to remote', () => {
    const { SIGNER: _s, SIGNER_URL: _u, SIGNER_API_KEY: _k, SIGNER_KEY_ID: _i, ...noSigner } = mainnetEnv;
    expect(problems(noSigner)).toContain('refusing to start on mainnet with the in-memory dev policy signer (SIGNER=memory)');
    expect(problems({ ...mainnetEnv, SIGNER: 'memory' })).toContain('refusing to start on mainnet with the in-memory dev policy signer (SIGNER=memory)');
    expect(problems({ ...mainnetEnv, SIGNER: 'kms' }).join('\n')).toMatch(/SIGNER=kms is retired: use SIGNER=remote/);
    expect(problems({ ...testnetEnv, SIGNER: 'hsm' }).join('\n')).toMatch(/SIGNER must be "memory" \(dev\) or "remote"/);
  });

  it('remote needs URL, API key, key id and COLLECTION_ADDRESS; live key on mainnet; no PARENT_KEY_FILE', () => {
    const p = problems({ ...testnetEnv, SIGNER: 'remote' }).join('\n');
    for (const k of ['SIGNER_URL is required', 'SIGNER_API_KEY is required', 'SIGNER_KEY_ID is required']) expect(p).toContain(k);
    expect(p).not.toMatch(/PARENT_KEY_FILE is required/);
    expect(problems({ ...mainnetEnv, SIGNER_API_KEY: testKey })).toContain('SIGNER_API_KEY must be a live key (bsh_live_...) on mainnet');
    expect(problems({ ...mainnetEnv, SIGNER_API_KEY: 'hunter2' }).join('\n')).toMatch(/SIGNER_API_KEY must be a @bsh\/edge API key/);
    expect(problems({ ...mainnetEnv, SIGNER_KEY_ID: 'bad id!' }).join('\n')).toMatch(/SIGNER_KEY_ID must be/);
    expect(problems({ ...mainnetEnv, SIGNER_URL: 'ftp://x' }).join('\n')).toMatch(/SIGNER_URL/);
    expect(problems({ ...testnetEnv, SIGNER: 'remote', SIGNER_URL: 'http://s', SIGNER_API_KEY: testKey, SIGNER_KEY_ID: 'k', PARENT_KEY_FILE: '/tmp/k' }).join('\n')).toMatch(
      /PARENT_KEY_FILE is only read with SIGNER=memory/,
    );
    expect(problems({ NETWORK: 'regtest', SIGNER: 'remote', SIGNER_URL: 'http://s', SIGNER_API_KEY: testKey, SIGNER_KEY_ID: 'k' }).join('\n')).toMatch(
      /COLLECTION_ADDRESS is required with SIGNER=remote/,
    );
    expect(loadConfig({ ...mainnetEnv, SIGNER_TIMEOUT_MS: '2500', SIGNER_RETRIES: '0' }).remoteSigner).toMatchObject({ timeoutMs: 2500, retries: 0 });
  });
});

describe('config: durable by default and the event bus (p5.3)', () => {
  it('production networks never run in-memory stores', () => {
    for (const net of ['testnet', 'signet', 'mainnet']) {
      const p = problems({ NETWORK: net });
      expect(p).toContain(`DATABASE_PATH is required on ${net}: production networks never run in-memory stores`);
      expect(p).toContain(`CONTENT_DIR is required on ${net}: production networks never run an in-memory content store`);
    }
    expect(loadConfig({ NETWORK: 'regtest' }).databasePath).toBeNull();
    // A hand-built config cannot sneak past it either.
    const handBuilt: MintConfig = { ...loadConfig({ ...testnetEnv, PARENT_KEY_FILE: keyFile() }), databasePath: null };
    expect(() => buildRuntime(handBuilt, silentLogger)).toThrow(/production networks never run in-memory stores/);
  });

  it('mainnet refuses to start without AMQP_URL; signet/testnet warn; regtest is silent', () => {
    const { AMQP_URL: _a, ...noBus } = mainnetEnv;
    expect(problems(noBus).join('\n')).toMatch(/AMQP_URL is required on mainnet: events .* are how block.space and the studio learn about mints/);
    for (const net of ['testnet', 'signet'] as const) {
      const c = loadConfig({ ...testnetEnv, NETWORK: net, COLLECTION_ADDRESS: addr('testnet'), PARENT_KEY_FILE: keyFile() });
      expect(c.bus).toBeNull();
      expect(c.warnings.join('\n')).toMatch(new RegExp(`AMQP_URL unset on ${net}: events stay in this process`));
    }
    expect(loadConfig({ NETWORK: 'regtest' }).warnings).toEqual([]);
    expect(problems({ ...mainnetEnv, AMQP_URL: 'http://rabbit:5672' })).toContain('AMQP_URL must be an amqp:// or amqps:// URL');
    expect(problems({ ...mainnetEnv, AMQP_EXCHANGE: 'bad exchange' }).join('\n')).toMatch(/AMQP_EXCHANGE/);
    expect(loadConfig({ ...mainnetEnv, AMQP_EXCHANGE: 'degent.events', AMQP_CONNECT_TIMEOUT_MS: '3000' }).bus).toMatchObject({ exchange: 'degent.events', connectTimeoutMs: 3000 });
  });

  it('MINT_ADMIN_API_KEYS_JSON: hash-only mint:admin records of the network key environment', () => {
    const hash = hashApiKey(liveKey);
    const c = loadConfig({ ...mainnetEnv, MINT_ADMIN_API_KEYS_JSON: JSON.stringify([{ id: 'ops', hash, scopes: ['mint:admin'], name: 'on-call' }]) });
    expect(c.adminApiKeys).toEqual([{ id: 'ops', hash, env: 'live', scopes: ['mint:admin'], name: 'on-call' }]);
    const bad = (v: unknown) => problems({ ...mainnetEnv, MINT_ADMIN_API_KEYS_JSON: JSON.stringify(v) }).join('\n');
    expect(bad([{ id: 'ops', key: liveKey, hash, scopes: ['mint:admin'] }])).toMatch(/plaintext key/);
    expect(bad([{ id: 'ops', hash, scopes: ['mint:admin', 'studio:internal'] }])).toMatch(/scopes must be \["mint:admin"\]/);
    expect(bad([{ id: 'ops', hash, env: 'test', scopes: ['mint:admin'] }])).toMatch(/env must be live on mainnet/);
    expect(bad({ id: 'ops' })).toMatch(/must be a JSON array/);
    expect(problems({ ...mainnetEnv, MINT_ADMIN_API_KEYS_JSON: '[' })).toContain('MINT_ADMIN_API_KEYS_JSON must be a JSON array');
    expect(loadConfig(mainnetEnv).warnings.join('\n')).toMatch(/no MINT_ADMIN_API_KEYS_JSON/);
  });
});

function keyFile(): string {
  const f = join(dir, 'parent.key');
  writeFileSync(f, Buffer.from(PARENT_KEY).toString('hex'));
  return f;
}

function capturingLog() {
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const at = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => void lines.push({ level, msg, fields });
  const log: Logger = { info: at('info'), warn: at('warn'), error: at('error') };
  return { log, lines };
}

const AMQP = 'amqp://degent-mint:s3cret@127.0.0.1:5672/bsh';

async function createOrder(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }) {
  const bytes = standardArt();
  const res = await app.request('/v1/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tier: tierForSize(bytes.length)!.tier,
      contentType: 'image/png',
      contentLength: bytes.length,
      contentSha256: sha256Hex(bytes),
      recipientAddress: regtestAddress(42),
      revealPubkey: Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex'),
      feeRate: 2,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { order: { id: string } }).order.id;
}

describe('startRuntime: RabbitMQ through connectAmqpBus', () => {
  it('connects at startup, bridges every mint event onto the exchange, reports bus health and shuts down gracefully', async () => {
    const broker = new FakeBroker();
    const { log, lines } = capturingLog();
    let lost = 0;
    const rt = await startRuntime(loadConfig({ NETWORK: 'regtest', AMQP_URL: AMQP }), log, { amqplib: broker.module, busFlushIntervalMs: 0, onBusLost: () => lost++ });
    expect(broker.urls).toEqual([AMQP]);
    expect(broker.exchanges.get('bsh.events')).toBe('topic');
    expect(broker.exchanges.get('bsh.events.dlx')).toBe('direct');
    // Credentials never reach a log line.
    expect(JSON.stringify(lines)).not.toContain('s3cret');
    expect(lines.find((l) => l.msg === 'event bus connected')?.fields.url).toBe('amqp://degent-mint:***@127.0.0.1:5672/bsh');

    // An order transition from the HTTP API reaches the broker as a CloudEvents envelope.
    const orderId = await createOrder(rt.app);
    expect(broker.published).toHaveLength(1);
    expect(broker.published[0]).toMatchObject({
      exchange: 'bsh.events',
      routingKey: 'degent.mint.order.awaiting_content',
      body: { id: `${orderId}:1`, type: 'degent.mint.order.awaiting_content', source: 'urn:bsh:degent-mint', subject: orderId },
      options: { persistent: true, messageId: `${orderId}:1`, contentType: 'application/cloudevents+json' },
    });
    expect(rt.events.orderEvents).toHaveLength(1); // the in-process history still sees it

    // The degent-owned royalty topic is accepted by the bus registry (the platform registry alone would refuse it).
    const royalty: RoyaltyPaidEvent = {
      type: 'degent.mint.royalty.paid',
      eventId: `${orderId}:royalty`,
      orderId,
      network: 'regtest',
      artworkId: 'art_1',
      artist: regtestAddress(60),
      sats: 330,
      txid: 'b'.repeat(64),
      vout: 1,
      at: '2026-09-24T00:00:00.000Z',
    };
    await rt.bus.publish(royalty);
    expect(broker.published.at(-1)).toMatchObject({ routingKey: 'degent.mint.royalty.paid', body: { id: `${orderId}:royalty` } });

    let health = await (await rt.app.request('/v1/health')).json();
    expect(health.checks.bus).toEqual({ ok: true, detail: 'amqp bsh.events connected' });

    // Broker nacks: the transition is not broken, the event waits in the backlog and health says so.
    broker.confirm = 'nack';
    await createOrder(rt.app);
    expect(rt.bus.status()).toMatchObject({ pending: 1, connected: true });
    health = await (await rt.app.request('/v1/health')).json();
    expect(health.status).toBe('degraded');
    expect(health.checks.bus.detail).toMatch(/1 event\(s\) pending/);
    expect(lines.some((l) => l.msg === 'event.publish.failed' && l.level === 'error')).toBe(true);
    // Broker recovers: the backlog drains in order.
    broker.confirm = 'ack';
    await rt.bus.flush();
    expect(rt.bus.status().pending).toBe(0);
    expect(broker.published.at(-1)!.routingKey).toBe('degent.mint.order.awaiting_content');

    // The connection drops: onBusLost fires once (main.ts shuts down for a supervisor restart), health reports it.
    broker.last.drop();
    broker.last.drop();
    expect(lost).toBe(1);
    health = await (await rt.app.request('/v1/health')).json();
    expect(health.checks.bus).toMatchObject({ ok: false, detail: expect.stringMatching(/disconnected: connection closed/) });

    await rt.shutdown();
    await rt.shutdown();
    expect(broker.last.channel!.closed).toBe(true);
    expect(broker.last.closed).toBe(true);
  });

  it('graceful shutdown with a healthy broker flushes, closes channel then connection, and is not reported as a loss', async () => {
    const broker = new FakeBroker();
    let lost = 0;
    const rt = await startRuntime(loadConfig({ NETWORK: 'regtest', AMQP_URL: AMQP, AMQP_EXCHANGE: 'degent.events' }), silentLogger, {
      amqplib: broker.module,
      busFlushIntervalMs: 0,
      onBusLost: () => lost++,
    });
    expect(broker.exchanges.has('degent.events')).toBe(true);
    await rt.shutdown();
    expect(broker.last.channel!.closed).toBe(true);
    expect(broker.last.closed).toBe(true);
    broker.last.emit('close');
    expect(lost).toBe(0);
  });

  it('refuses to start when the broker is unreachable or silent (startup health check); never leaks the password', async () => {
    const refused = new FakeBroker();
    refused.connectMode = 'refuse';
    const e1 = await startRuntime(loadConfig({ NETWORK: 'regtest', AMQP_URL: AMQP }), silentLogger, { amqplib: refused.module }).catch((e) => e);
    expect(e1).toBeInstanceOf(StartupError);
    expect(e1.message).toMatch(/event bus unreachable \(amqp:\/\/degent-mint:\*\*\*@127.0.0.1:5672\/bsh, exchange bsh.events\): connect ECONNREFUSED/);
    expect(e1.message).not.toContain('s3cret');

    const silent = new FakeBroker();
    silent.connectMode = 'hang';
    const e2 = await startRuntime(loadConfig({ NETWORK: 'regtest', AMQP_URL: AMQP, AMQP_CONNECT_TIMEOUT_MS: '500' }), silentLogger, { amqplib: silent.module }).catch((e) => e);
    expect(e2).toBeInstanceOf(StartupError);
    expect(e2.message).toMatch(/no answer within 500 ms/);
    expect(redactUrl('amqps://u:p@h/v')).toBe('amqps://u:***@h/v');
  });

  it('without AMQP_URL (regtest) events stay in-process and health says so', async () => {
    const rt = await startRuntime(loadConfig({ NETWORK: 'regtest' }), silentLogger);
    expect(rt.amqp).toBeNull();
    const health = await (await rt.app.request('/v1/health')).json();
    expect(health.checks.bus).toEqual({ ok: true, detail: 'in-process only (AMQP_URL unset): events do not leave this process' });
    await rt.shutdown();
  });
});

describe('BridgedEventBus', () => {
  const ev = (n: number): OrderStatusEvent => ({
    type: 'degent.mint.order.paid',
    eventId: `ord_${n}:3`,
    orderId: `ord_${n}`,
    network: 'regtest',
    status: 'paid',
    previousStatus: 'awaiting_payment',
    at: '2026-09-24T00:00:00.000Z',
    lane: 'standard',
  });

  it('a broker that never confirms cannot stall a transition: publish times out, later events only queue, drain logs the loss', async () => {
    let calls = 0;
    const silentBus: PlatformBus = { publish: () => (calls++, new Promise<void>(() => {})), subscribe: () => Promise.reject(new Error('no')) };
    const { log, lines } = capturingLog();
    let now = 0;
    const bus = new BridgedEventBus(new MemoryEventBus(), silentBus, { log, publishTimeoutMs: 50, retryAfterMs: 1_000, now: () => new Date(now) });
    await bus.publish(ev(1));
    expect(calls).toBe(1);
    await bus.publish(ev(2)); // inside the retry-after window: queued without touching the broker
    expect(calls).toBe(1);
    expect(bus.status()).toMatchObject({ pending: 2, lastError: 'broker did not confirm within 50 ms' });
    now = 2_000;
    await bus.publish(ev(3)); // window over: tries the OLDEST first (ordering), fails again
    expect(calls).toBe(2);
    await bus.drain();
    expect(lines.filter((l) => l.msg === 'event.publish.lost').map((l) => l.fields.eventId)).toEqual(['ord_1:3', 'ord_2:3', 'ord_3:3']);
    expect(bus.status()).toMatchObject({ pending: 0, dropped: 3 });
  });

  it('drops (and logs) an event that can never match its topic schema instead of blocking the backlog', async () => {
    const platform = new InMemoryBus();
    const got: EventEnvelope[] = [];
    await platform.subscribe('#', async (e) => void got.push(e));
    const { log, lines } = capturingLog();
    const bus = new BridgedEventBus(new MemoryEventBus(), platform, { log });
    await bus.publish({ ...ev(1), lane: 'express' } as unknown as OrderStatusEvent);
    await bus.publish(ev(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(got.map((e) => e.id)).toEqual(['ord_2:3']);
    expect(lines.find((l) => l.msg === 'event.publish.lost')?.fields.eventId).toBe('ord_1:3');
    expect(bus.status()).toMatchObject({ pending: 0, published: 1, dropped: 1 });
  });

  it('bounds the backlog by dropping the oldest', async () => {
    const failing: PlatformBus = { publish: () => Promise.reject(new Error('channel closed')), subscribe: () => Promise.reject(new Error('no')) };
    const bus = new BridgedEventBus(new MemoryEventBus(), failing, { maxPending: 2, retryAfterMs: 0 });
    for (let i = 1; i <= 3; i++) await bus.publish(ev(i));
    expect(bus.status()).toMatchObject({ pending: 2, dropped: 1 });
  });
});

describe('startRuntime: SIGNER=remote preflight', () => {
  const remoteTestnet = (over: Record<string, string> = {}) =>
    loadConfig({
      ...testnetEnv,
      DATABASE_PATH: join(mkdtempSync(join(tmpdir(), 'degent-remote-')), 'mint.db'),
      SIGNER: 'remote',
      SIGNER_URL: 'http://signer.test',
      SIGNER_API_KEY: testKey,
      SIGNER_KEY_ID,
      ...over,
    });

  it('verifies the signer (network + COLLECTION_ADDRESS key) before serving; /v1/health reports it', async () => {
    const svc = makeSignerService({ network: 'testnet' });
    const cfg = remoteTestnet({ SIGNER_API_KEY: svc.apiKey });
    expect(cfg.warnings.join('\n')).toMatch(/AMQP_URL unset on testnet/);
    const rt = await startRuntime(cfg, silentLogger, { signerFetch: svc.fetch });
    expect(rt.signer.kind).toBe('remote');
    expect(rt.signer.collectionAddress()).toBe(addr('testnet'));
    const health = await (await rt.app.request('/v1/health')).json();
    expect(health.checks.signer).toMatchObject({ ok: true, detail: expect.stringMatching(/remote signer ok \(testnet, key degent-parent\)/) });
    await rt.shutdown();
  });

  it('refuses to start when the signer key is not the collection key, or the signer is on another network', async () => {
    const other = makeSignerService({ network: 'testnet', keys: new (await import('@bsh/signer')).InMemoryKeyProvider([[SIGNER_KEY_ID, new Uint8Array(32).fill(9)]]) });
    const e1 = await startRuntime(remoteTestnet({ SIGNER_API_KEY: other.apiKey }), silentLogger, { signerFetch: other.fetch }).catch((e) => e);
    expect(e1).toBeInstanceOf(StartupError);
    expect(e1.message).toMatch(/remote signer preflight failed: .*not COLLECTION_ADDRESS/);
    const regtestSigner = makeSignerService({ network: 'regtest' });
    const e2 = await startRuntime(remoteTestnet({ SIGNER_API_KEY: regtestSigner.apiKey }), silentLogger, { signerFetch: regtestSigner.fetch }).catch((e) => e);
    expect(e2.message).toMatch(/runs on regtest, the mint on testnet/);
  });
});
