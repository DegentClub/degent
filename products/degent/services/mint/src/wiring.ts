/**
 * Composition root: builds real adapters from MintConfig. main.ts calls this; tests can call it
 * with a regtest config to prove the wiring is sound.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { InMemoryNonceStore, type NonceStore, type SigningKey } from '@bsh/identity';
import { addressToScript } from '@bsh/inscription';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import type { MintConfig } from './config.js';
import { ConfigError } from './config.js';
import { OrderService } from './application/order-service.js';
import { ApprovalService } from './application/approval-service.js';
import { RegisterService } from './application/register-service.js';
import { OrderNotificationService } from './application/notification-service.js';
import { MemoryOrderSubscriptionStore, SqliteOrderSubscriptionStore } from './adapters/order-subscription-stores.js';
import { ConsoleEmailSender, HttpTelegramClient } from '@bsh/notify';
import type { OrderSubscriptionStore } from './ports/order-subscription-store.js';
import { parseRoster } from './domain/roster.js';
import { MemoryHolderRegistry } from './adapters/memory-holder-registry.js';
import { RosterChainHolderRegistry } from './adapters/roster-chain-holder-registry.js';
import { MemoryVoteStore, SqliteNonceStore, SqliteVoteStore } from './adapters/vote-stores.js';
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
import { StoreParentUtxoProvider } from './adapters/store-parent-utxo.js';
import { CompositeArtReview, RulesArtReview } from './adapters/rules-art-review.js';
import { ClaudeArtReview } from './adapters/claude-art-review.js';
import { MemoryEventBus, systemClock } from './adapters/system.js';
import type { Broadcaster } from './ports/broadcaster.js';
import type { ChainPort } from './ports/chain.js';
import type { HolderRegistry } from './ports/holder-registry.js';
import type { OrderStore } from './ports/order-store.js';
import type { SecretBlobStore } from './ports/reveal-vault.js';
import type { VoteStore } from './ports/vote-store.js';

/** Regtest-only session key: never used off regtest (config refuses a missing SESSION_KEY there). */
export const REGTEST_DEV_SESSION_KEY = '22'.repeat(32);

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Runtime {
  app: Hono;
  worker: MintWorker;
  orders: OrderService;
  approval: ApprovalService;
  register: RegisterService;
  notifications: OrderNotificationService;
  holders: HolderRegistry;
  parents: StoreParentUtxoProvider;
  chain: ChainPort;
  events: MemoryEventBus;
  signer: InMemoryPolicySigner;
  close(): void;
}

export function buildRuntime(cfg: MintConfig, log: Logger = jsonLogger()): Runtime {
  const net = cfg.settings.network;

  // Signer first: the collection address must be the signer's address.
  let signer: InMemoryPolicySigner;
  if (cfg.parentKeyFile) {
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
  let votes: VoteStore;
  let nonces: NonceStore;
  let subscriptions: OrderSubscriptionStore;
  if (cfg.databasePath) {
    const sqlite = new SqliteOrderStore(cfg.databasePath);
    store = sqlite;
    blobs = sqlite;
    votes = new SqliteVoteStore(sqlite.database);
    nonces = new SqliteNonceStore(sqlite.database);
    subscriptions = new SqliteOrderSubscriptionStore(sqlite.database);
  } else {
    store = new MemoryOrderStore();
    blobs = new MemorySecretBlobStore();
    votes = new MemoryVoteStore();
    nonces = new InMemoryNonceStore();
    subscriptions = new MemoryOrderSubscriptionStore();
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
  const parents = new StoreParentUtxoProvider(store);
  const orders = new OrderService({ settings, store, content, reveals, review, events, clock: systemClock, chain, votes, parents });

  // The Register: the Gallery roster plus holders from the chain (ADR-0007 §4).
  const rosterPath = resolve(serviceDir, cfg.rosterFile);
  const roster = parseRoster(JSON.parse(readFileSync(rosterPath, 'utf8')));
  let holders: HolderRegistry;
  if (cfg.holderRegistry === 'roster-chain') {
    holders = new RosterChainHolderRegistry(roster, { esploraUrl: cfg.esploraUrl, ordUrl: cfg.ordUrl, clock: systemClock });
  } else {
    holders = new MemoryHolderRegistry();
    log.warn('HOLDER_REGISTRY=memory: nobody is a member until addresses are added (dev only)', {});
  }
  const sessionKey: SigningKey = { kid: cfg.sessionKid, secretKey: hexToBytes(cfg.sessionKey ?? REGTEST_DEV_SESSION_KEY) };
  if (!cfg.sessionKey) log.warn('using the regtest dev session key', {});
  const approval = new ApprovalService({ orders, store, votes, holders, clock: systemClock, sessionKey, nonces, log });
  const register = new RegisterService({ settings, roster, store, holders, clock: systemClock });

  // Order notifications (@bsh/notify): follow the in-process order events.
  const notifications = new OrderNotificationService({
    orders,
    subscriptions,
    email: cfg.notify.email === 'console' ? new ConsoleEmailSender((line) => log.info('email (console sender)', { line })) : null,
    telegram: cfg.notify.telegramBotToken ? new HttpTelegramClient({ botToken: cfg.notify.telegramBotToken, fetch: (u, i) => fetch(u, i) }) : null,
    clock: systemClock,
    siteUrl: cfg.notify.siteUrl,
    log,
  });
  notifications.attach(events);
  if (notifications.availableChannels().length === 0) log.info('order notifications disabled (NOTIFY_EMAIL=off, no TELEGRAM_BOT_TOKEN)', {});

  const app = createApp({
    orders,
    approval,
    register,
    notifications,
    fees,
    chain,
    parents,
    clock: systemClock,
    corsOrigins: cfg.corsOrigins,
    rateLimit: { windowMs: 60_000, max: cfg.rateLimitPerMinute },
    trustProxy: cfg.trustProxy,
    log,
  });
  const worker = new MintWorker({ orders, store, content, reveals, chain, parents, signer, broadcasters, clock: systemClock, log });
  return {
    app,
    worker,
    orders,
    approval,
    register,
    notifications,
    holders,
    parents,
    chain,
    events,
    signer,
    close: () => {
      notifications.stop();
      store.close?.();
    },
  };
}

/** Seed the parent location from PARENT_OUTPOINT when the store has none yet. */
export async function initialiseParent(rt: Runtime, cfg: MintConfig, log: Logger): Promise<void> {
  if (await rt.parents.current()) return;
  if (!cfg.parentOutpoint) {
    log.warn('no parent UTXO known: set PARENT_OUTPOINT; reveals are paused until then', {});
    return;
  }
  const tx = await rt.chain.getTx(cfg.parentOutpoint.txid);
  const out = tx?.vout[cfg.parentOutpoint.vout];
  if (!tx || !out) throw new Error('PARENT_OUTPOINT not found on chain');
  const expected = bytesToHex(addressToScript(rt.signer.collectionAddress(), cfg.settings.network));
  if (out.scriptHex.toLowerCase() !== expected) throw new Error('PARENT_OUTPOINT is not held by the collection key');
  await rt.parents.initialise({ ...cfg.parentOutpoint, value: out.value, scriptHex: expected, confirmed: tx.confirmed, createdByLane: null });
}
