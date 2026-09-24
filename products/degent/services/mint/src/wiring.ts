/**
 * Composition root: builds real adapters from MintConfig. `startRuntime` (main.ts) connects the event
 * bus, builds the runtime and runs the startup preflight (bus health, remote signer key/network);
 * `buildRuntime` is the synchronous part that tests call with a regtest config to prove the wiring.
 */
import { readFileSync } from 'node:fs';
import { InMemoryApiKeyStore } from '@bsh/edge';
import { connectAmqpBus, type AmqplibModule, type ConnectedAmqpBus, type EventBus as PlatformBus } from '@bsh/events';
import type { FetchLike } from '@bsh/signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { addressToScript } from '@bsh/inscription';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import type { MintConfig } from './config.js';
import { ConfigError } from './config.js';
import { OrderService } from './application/order-service.js';
import { jsonLogger, type Logger } from './application/logger.js';
import { MintWorker } from './worker.js';
import { MemoryOrderStore } from './adapters/memory-order-store.js';
import { SqliteOrderStore } from './adapters/sqlite-order-store.js';
import { FsContentStore, MemoryContentStore } from './adapters/content-stores.js';
import { EncryptedRevealVault, MemorySecretBlobStore, REGTEST_DEV_REVEAL_KEY } from './adapters/reveal-vault.js';
import { EsploraChain } from './adapters/esplora-chain.js';
import { EsploraFees } from './adapters/fees.js';
import { EsploraBroadcaster, FanoutBroadcaster, LibreRelayBroadcaster, SlipstreamBroadcaster } from './adapters/broadcasters.js';
import { InMemoryPolicySigner } from './adapters/in-memory-policy-signer.js';
import { RemotePolicySigner } from './adapters/remote-policy-signer.js';
import { BridgedEventBus, mintEventRegistry } from './adapters/platform-event-bus.js';
import { StoreParentUtxoProvider } from './adapters/store-parent-utxo.js';
import { CompositeArtReview, RulesArtReview } from './adapters/rules-art-review.js';
import { ClaudeArtReview } from './adapters/claude-art-review.js';
import { MemoryEventBus, systemClock } from './adapters/system.js';
import { MetaEditionStore } from './adapters/edition-store.js';
import { HttpStudioClient, MemoryStudioClient } from './adapters/studio-client.js';
import { HttpLedgerClient, MemoryLedgerClient } from './adapters/ledger-client.js';
import type { Broadcaster } from './ports/broadcaster.js';
import type { ChainPort } from './ports/chain.js';
import type { EditionStore } from './ports/edition-store.js';
import type { LedgerClient } from './ports/ledger-client.js';
import type { OrderStore } from './ports/order-store.js';
import type { ParentUtxo } from './ports/parent-utxo.js';
import type { PolicySigner } from './ports/policy-signer.js';
import type { SecretBlobStore } from './ports/reveal-vault.js';
import type { StudioClient } from './ports/studio-client.js';

export interface Runtime {
  app: Hono;
  worker: MintWorker;
  orders: OrderService;
  parents: StoreParentUtxoProvider;
  chain: ChainPort;
  /** In-process history of every event (also bridged to RabbitMQ when a platform bus is attached). */
  events: MemoryEventBus;
  /** What the order service publishes to: `events` plus the platform bus, with status for /v1/health. */
  bus: BridgedEventBus;
  signer: PolicySigner;
  /** Open Studio wiring: HTTP clients when configured, in-memory fakes on regtest, undefined otherwise. */
  studio: StudioClient | undefined;
  ledger: LedgerClient | undefined;
  editions: EditionStore;
  close(): void;
}

export interface RuntimeDeps {
  /** Platform bus to bridge events onto (the AMQP bus from `connectAmqpBus` in production). */
  platformBus?: PlatformBus;
  /** fetch for the remote signer client (tests: the in-process signer app; production: an mTLS-bound fetch). */
  signerFetch?: FetchLike;
  signerSleep?: (ms: number) => Promise<void>;
}

export function buildRuntime(cfg: MintConfig, log: Logger = jsonLogger(), deps: RuntimeDeps = {}): Runtime {
  const net = cfg.settings.network;
  // Durable by default (p5.3): loadConfig already refuses this; the guard keeps a hand-built config honest.
  if (net !== 'regtest' && (!cfg.databasePath || !cfg.contentDir))
    throw new ConfigError([`${net} needs DATABASE_PATH and CONTENT_DIR: production networks never run in-memory stores`]);

  // Signer first: the collection address must be the signer's address.
  let signer: PolicySigner;
  if (cfg.signer === 'remote') {
    if (!cfg.remoteSigner || !cfg.settings.collectionAddress) throw new ConfigError(['SIGNER=remote needs SIGNER_URL, SIGNER_API_KEY, SIGNER_KEY_ID and COLLECTION_ADDRESS']);
    signer = RemotePolicySigner.fromConfig(cfg.remoteSigner, {
      network: net,
      collectionAddress: cfg.settings.collectionAddress,
      policy: cfg.settings.policy,
      log,
      ...(deps.signerFetch ? { fetch: deps.signerFetch } : {}),
      ...(deps.signerSleep ? { sleep: deps.signerSleep } : {}),
    });
  } else if (cfg.parentKeyFile) {
    const hex = readFileSync(cfg.parentKeyFile, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new ConfigError(['PARENT_KEY_FILE must contain 32 bytes of hex']);
    signer = new InMemoryPolicySigner(hexToBytes(hex), net, cfg.settings.policy, log);
  } else if (net === 'regtest') {
    signer = InMemoryPolicySigner.random(net, cfg.settings.policy);
    log.warn('using an ephemeral random parent key (regtest dev only)', { collectionAddress: signer.collectionAddress() });
  } else {
    throw new ConfigError(['no parent signer configured']);
  }
  const collectionAddress = cfg.settings.collectionAddress || signer.collectionAddress();
  if (collectionAddress !== signer.collectionAddress())
    throw new ConfigError(['COLLECTION_ADDRESS does not match the parent signing key']);
  const settings = { ...cfg.settings, collectionAddress };

  let store: OrderStore & Partial<SecretBlobStore>;
  let blobs: SecretBlobStore;
  if (cfg.databasePath) {
    const sqlite = new SqliteOrderStore(cfg.databasePath);
    store = sqlite;
    blobs = sqlite;
  } else {
    store = new MemoryOrderStore();
    blobs = new MemorySecretBlobStore();
  }
  const content = cfg.contentDir ? new FsContentStore(cfg.contentDir) : new MemoryContentStore();
  const reveals = new EncryptedRevealVault(blobs, cfg.revealEncryptionKey ?? REGTEST_DEV_REVEAL_KEY);

  const chain = new EsploraChain({ esploraUrl: cfg.esploraUrl, ordUrl: cfg.ordUrl });
  const fees = new EsploraFees({ esploraUrl: cfg.esploraUrl, minFeeRate: settings.collection.minFeeRate });
  const standard = new EsploraBroadcaster({ esploraUrl: cfg.esploraUrl });
  const blockTargets: Broadcaster[] = [];
  if (cfg.libre) blockTargets.push(new LibreRelayBroadcaster({ rpcUrl: cfg.libre.url, user: cfg.libre.user, password: cfg.libre.password }));
  if (cfg.slipstream)
    blockTargets.push(new SlipstreamBroadcaster({ url: cfg.slipstream.url, ...(cfg.slipstream.apiKey ? { apiKey: cfg.slipstream.apiKey } : {}) }));
  if (blockTargets.length === 0) {
    log.warn('no Libre Relay / Slipstream configured: block lane falls back to esplora (test networks only)', {});
    blockTargets.push(standard);
  }
  const broadcasters = { standard, block: blockTargets.length === 1 ? blockTargets[0]! : new FanoutBroadcaster(blockTargets) };

  const reviewers = [new RulesArtReview(settings.collection)] as ConstructorParameters<typeof CompositeArtReview>[0];
  const guidelines = cfg.artReviewGuidelinesFile ? readFileSync(cfg.artReviewGuidelinesFile, 'utf8') : undefined;
  const vision = ClaudeArtReview.fromEnv(cfg.artReviewApiKey ?? undefined, guidelines);
  if (vision) reviewers.push(vision);
  else log.info('vision art review disabled (no ART_REVIEW_API_KEY)', {});
  const review = new CompositeArtReview(reviewers);

  const events = new MemoryEventBus();
  const bus = new BridgedEventBus(events, deps.platformBus ?? null, { log, ...(cfg.bus ? { exchange: cfg.bus.exchange } : {}) });
  const parents = new StoreParentUtxoProvider(store, { log });

  // Open Studio (ADR-0007, plan §3): the studio feeds artwork orders, the ledger records them (never blocking).
  const editions = new MetaEditionStore(store);
  let studio: StudioClient | undefined;
  if (cfg.studio) studio = new HttpStudioClient({ studioUrl: cfg.studio.url, apiKey: cfg.studio.apiKey });
  else if (net === 'regtest') {
    studio = new MemoryStudioClient();
    log.info('artwork orders use an empty in-memory studio (regtest dev only); set STUDIO_URL for a real one', {});
  } else log.info('artwork orders disabled (no STUDIO_URL)', {});
  let ledger: LedgerClient | undefined;
  if (cfg.ledger) ledger = new HttpLedgerClient({ ledgerUrl: cfg.ledger.url, apiKey: cfg.ledger.apiKey, product: 'degent' });
  else if (net === 'regtest') ledger = new MemoryLedgerClient();
  else log.info('ledger recording disabled (no LEDGER_URL)', {});

  const orders = new OrderService({ settings, store, content, reveals, review, events: bus, clock: systemClock, chain, fees, editions, studio, ledger, log });
  const adminKeys = new InMemoryApiKeyStore();
  for (const k of cfg.adminApiKeys) adminKeys.add(k);
  const healthChecks: NonNullable<Parameters<typeof createApp>[0]['healthChecks']> = { bus: async () => bus.health() };
  if (signer.health) {
    const s = signer;
    healthChecks.signer = () => s.health!();
  }
  const app = createApp({
    orders,
    fees,
    chain,
    parents,
    clock: systemClock,
    corsOrigins: cfg.corsOrigins,
    rateLimit: { windowMs: 60_000, max: cfg.rateLimitPerMinute },
    trustProxy: cfg.trustProxy,
    log,
    healthChecks,
    admin: { keys: adminKeys, environment: cfg.adminApiKeyEnvironment },
  });
  const worker = new MintWorker({ orders, store, content, reveals, chain, parents, signer, broadcasters, clock: systemClock, log });
  return { app, worker, orders, parents, chain, events, bus, signer, studio, ledger, editions, close: () => store.close?.() };
}

export interface StartOptions {
  /** Injected amqplib module (tests pass a fake; production lazily imports the platform's optional peer). */
  amqplib?: AmqplibModule;
  signerFetch?: FetchLike;
  signerSleep?: (ms: number) => Promise<void>;
  /** The broker closed the connection or channel after startup. main.ts shuts down so the supervisor restarts it. */
  onBusLost?: (info: { what: 'connection' | 'channel'; error?: unknown }) => void;
  /** Backlog flush period while running. Default 15 s; 0 disables the timer. */
  busFlushIntervalMs?: number;
}

export interface StartedRuntime extends Runtime {
  amqp: ConnectedAmqpBus | null;
  /** Graceful: flush the event backlog, close the AMQP channel and connection, then the store. Idempotent. */
  shutdown(): Promise<void>;
}

/** Startup refused: the bus or the remote signer failed its preflight. main.ts exits non-zero with the message. */
export class StartupError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'StartupError';
  }
}

/** Strip credentials from an AMQP URL before it reaches a log line or error. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'amqp://<invalid>';
  }
}

/**
 * Connect → build → preflight. When AMQP_URL is set the broker must answer (connect, confirm channel,
 * exchange declared) within AMQP_CONNECT_TIMEOUT_MS or startup is refused; with SIGNER=remote the signer
 * must answer on our network with the COLLECTION_ADDRESS key. Nothing is served before both pass.
 */
export async function startRuntime(cfg: MintConfig, log: Logger = jsonLogger(), opts: StartOptions = {}): Promise<StartedRuntime> {
  let amqp: ConnectedAmqpBus | null = null;
  let bus: BridgedEventBus | null = null;
  let lost = false;
  if (cfg.bus) {
    const target = redactUrl(cfg.bus.url);
    const connecting = connectAmqpBus({
      url: cfg.bus.url,
      service: 'degent-mint',
      exchange: cfg.bus.exchange,
      registry: mintEventRegistry(),
      socketOptions: { heartbeat: 30 },
      ...(opts.amqplib ? { amqplib: opts.amqplib } : {}),
      onClose: (info) => {
        if (lost) return;
        lost = true;
        const reason = `${info.what} closed${info.error ? `: ${info.error instanceof Error ? info.error.message : String(info.error)}` : ''}`;
        bus?.markDisconnected(reason);
        log.error('event bus connection lost', { event: 'bus.lost', what: info.what, reason });
        opts.onBusLost?.(info);
      },
      onNack: (i) => log.error('event publish nacked by the broker', { event: 'event.publish.nacked', routingKey: i.routingKey, eventId: i.messageId, error: i.error.message }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      amqp = await Promise.race([
        connecting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${cfg.bus!.connectTimeoutMs} ms`)), cfg.bus!.connectTimeoutMs);
        }),
      ]);
    } catch (e) {
      // A connection that completes after the timeout must not linger.
      void connecting.then((late) => late.close()).catch(() => undefined);
      throw new StartupError(`event bus unreachable (${target}, exchange ${cfg.bus.exchange}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
    log.info('event bus connected', { event: 'bus.connected', url: target, exchange: cfg.bus.exchange });
  }

  let rt: Runtime;
  try {
    rt = buildRuntime(cfg, log, {
      ...(amqp ? { platformBus: amqp.bus } : {}),
      ...(opts.signerFetch ? { signerFetch: opts.signerFetch } : {}),
      ...(opts.signerSleep ? { signerSleep: opts.signerSleep } : {}),
    });
    bus = rt.bus;
    if (lost) rt.bus.markDisconnected('closed during startup');
    if (rt.signer.verify) {
      try {
        await rt.signer.verify();
      } catch (e) {
        rt.close();
        throw new StartupError(`remote signer preflight failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      log.info('remote signer verified', { event: 'signer.verified', collectionAddress: rt.signer.collectionAddress() });
    }
  } catch (e) {
    await amqp?.close().catch(() => undefined);
    throw e;
  }

  const flushEvery = opts.busFlushIntervalMs ?? 15_000;
  const flusher = amqp && flushEvery > 0 ? setInterval(() => void rt.bus.flush(), flushEvery) : null;
  flusher?.unref?.();
  let closing: Promise<void> | null = null;
  const shutdown = () =>
    (closing ??= (async () => {
      if (flusher) clearInterval(flusher);
      await rt.bus.drain();
      if (amqp) {
        lost = true; // our own close is not a lost connection
        await amqp.close().catch((e) => log.warn('event bus close failed', { error: e instanceof Error ? e.message : String(e) }));
      }
      rt.close();
    })());
  return { ...rt, amqp, shutdown };
}

/** Seed the parent location from PARENT_OUTPOINT when the store has none yet. */
export async function initialiseParent(rt: Runtime, cfg: MintConfig, log: Logger): Promise<void> {
  if (await rt.parents.current()) return;
  if (!cfg.parentOutpoint) {
    log.warn('no parent UTXO known: set PARENT_OUTPOINT; reveals are paused until then', {});
    return;
  }
  await rt.parents.initialise(await checkParentOnChain(rt, cfg, cfg.parentOutpoint));
}

/** The on-chain parent at `outpoint`, checked: held by the collection key and worth exactly PARENT_VALUE_SATS. */
async function checkParentOnChain(rt: Runtime, cfg: MintConfig, outpoint: { txid: string; vout: number }): Promise<ParentUtxo> {
  const tx = await rt.chain.getTx(outpoint.txid);
  const out = tx?.vout[outpoint.vout];
  if (!tx || !out) throw new Error('PARENT_OUTPOINT not found on chain');
  const expected = bytesToHex(addressToScript(rt.signer.collectionAddress(), cfg.settings.network));
  if (out.scriptHex.toLowerCase() !== expected) throw new Error('PARENT_OUTPOINT is not held by the collection key');
  if (out.value !== BigInt(cfg.settings.parentValueSats))
    throw new Error(`PARENT_OUTPOINT value ${out.value} sats != PARENT_VALUE_SATS ${cfg.settings.parentValueSats}; browsers sign the parent return with that value (ADR-0005)`);
  return { ...outpoint, value: out.value, scriptHex: expected, confirmed: tx.confirmed, createdByLane: null };
}

/**
 * Operator re-lease (RUNBOOK "Re-leasing or re-initialising the parent"): move the stored parent to
 * `outpoint` after checking it on chain (collection script, value == PARENT_VALUE_SATS). Refuses while an
 * order holds the lease or sits in `revealing`. Logs `parent.lease.changed`; the value check means a
 * re-lease through here never trips the value circuit breaker.
 */
export async function reinitialiseParent(rt: Runtime, cfg: MintConfig, outpoint: { txid: string; vout: number }): Promise<ParentUtxo> {
  const revealing = await rt.orders.laneOccupancy();
  const busy = [...revealing.standard.inFlight, ...revealing.block.inFlight].filter((o) => o.status === 'revealing');
  if (busy.length > 0) throw new Error(`orders are revealing (${busy.map((o) => o.id).join(', ')}); drain the queue first`);
  const next = await checkParentOnChain(rt, cfg, outpoint);
  await rt.parents.initialise(next, { force: true });
  return next;
}
