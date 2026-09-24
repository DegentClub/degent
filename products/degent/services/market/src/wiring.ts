/** Composition root: config → adapters → services → HTTP app + settlement watcher. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InMemoryNonceStore, type NonceStore } from '@bsh/identity';
import type { Hono } from 'hono';
import { MarketAuth } from './application/auth.js';
import { ListingLifecycle } from './application/lifecycle.js';
import type { Logger } from './application/logger.js';
import { MarketService } from './application/market-service.js';
import { SettlementWatcher } from './application/settlement-watcher.js';
import { createApp } from './app.js';
import type { MarketConfig } from './config.js';
import { EsploraMarketChain } from './adapters/esplora-chain.js';
import { MemoryMarketStore } from './adapters/memory-store.js';
import { MemoryMembership, MintRegisterMembership, RosterOrdMembership, type RosterEntry } from './adapters/memberships.js';
import { OrdRecursiveIndexer } from './adapters/ord-indexer.js';
import { SqliteMarketStore, SqliteNonceStore } from './adapters/sqlite-store.js';
import { MemoryEventBus, systemClock } from './adapters/system.js';
import type { CollectionMembership } from './ports/membership.js';

export interface Runtime {
  app: Hono;
  market: MarketService;
  watcher: SettlementWatcher;
  events: MemoryEventBus;
  close(): void;
}

function loadRoster(file: string): RosterEntry[] {
  const j = JSON.parse(readFileSync(resolve(file), 'utf8')) as { members?: Array<{ n: number; inscriptionId: string }> };
  if (!Array.isArray(j.members)) throw new Error(`${file}: expected { members: [...] }`);
  return j.members.map((m) => ({ n: m.n, inscriptionId: m.inscriptionId }));
}

export function buildRuntime(cfg: MarketConfig, log: Logger): Runtime {
  const clock = systemClock;
  let store: MemoryMarketStore | SqliteMarketStore;
  let nonces: NonceStore;
  if (cfg.databasePath) {
    const sqlite = new SqliteMarketStore(cfg.databasePath);
    store = sqlite;
    nonces = new SqliteNonceStore(sqlite.db);
  } else {
    store = new MemoryMarketStore();
    nonces = new InMemoryNonceStore();
  }
  const chain = new EsploraMarketChain({ esploraUrl: cfg.esploraUrl });
  const ord = new OrdRecursiveIndexer({ ordUrl: cfg.ordUrl });
  let membership: CollectionMembership;
  if (cfg.membership === 'mint-register') membership = new MintRegisterMembership({ mintApiUrl: cfg.mintApiUrl! });
  else if (cfg.membership === 'roster') membership = new RosterOrdMembership(loadRoster(cfg.rosterFile!), { ordUrl: cfg.ordUrl, parentInscriptionId: cfg.parentInscriptionId });
  else membership = new MemoryMembership();

  const events = new MemoryEventBus();
  const s = cfg.settings;
  const lifecycle = new ListingLifecycle({ store, events, clock, network: s.network, log });
  const auth = new MarketAuth({ nonces, clock, network: s.network, domain: s.auth.domain, uri: s.auth.uri, ttlSeconds: s.challengeTtlSeconds, log });
  const market = new MarketService({ settings: s, listings: store, sessions: store, chain, ord, membership, auth, lifecycle, clock, log });
  const watcher = new SettlementWatcher({ settings: s, listings: store, chain, ord, lifecycle, clock, log, purgeSessions: () => market.purgeSessions() });
  const app = createApp({ market, clock, corsOrigins: cfg.corsOrigins, rateLimit: { windowMs: 60_000, max: cfg.rateLimitPerMinute }, trustProxy: cfg.trustProxy, log });
  return {
    app,
    market,
    watcher,
    events,
    close: () => {
      if (store instanceof SqliteMarketStore) store.close();
    },
  };
}
