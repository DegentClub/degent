/**
 * Composition root: builds real adapters from MintConfig. main.ts calls this; tests can call it
 * with a regtest config to prove the wiring is sound.
 */
import { readFileSync } from 'node:fs';
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
import type { SecretBlobStore } from './ports/reveal-vault.js';
import type { StudioClient } from './ports/studio-client.js';

export interface Runtime {
  app: Hono;
  worker: MintWorker;
  orders: OrderService;
  parents: StoreParentUtxoProvider;
  chain: ChainPort;
  events: MemoryEventBus;
  signer: InMemoryPolicySigner;
  /** Open Studio wiring: HTTP clients when configured, in-memory fakes on regtest, undefined otherwise. */
  studio: StudioClient | undefined;
  ledger: LedgerClient | undefined;
  editions: EditionStore;
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
  const parents = new StoreParentUtxoProvider(store);

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

  const orders = new OrderService({ settings, store, content, reveals, review, events, clock: systemClock, chain, fees, editions, studio, ledger, log });
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
  });
  const worker = new MintWorker({ orders, store, content, reveals, chain, parents, signer, broadcasters, clock: systemClock, log });
  return { app, worker, orders, parents, chain, events, signer, studio, ledger, editions, close: () => store.close?.() };
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
  if (out.value !== BigInt(cfg.settings.parentValueSats))
    throw new Error(`PARENT_OUTPOINT value ${out.value} sats != PARENT_VALUE_SATS ${cfg.settings.parentValueSats}; browsers sign the parent return with that value (ADR-0005)`);
  await rt.parents.initialise({ ...cfg.parentOutpoint, value: out.value, scriptHex: expected, confirmed: tx.confirmed, createdByLane: null });
}
