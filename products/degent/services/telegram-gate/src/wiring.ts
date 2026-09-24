/** Builds the runtime from config: adapters by environment, the service, the HTTP app and (optionally) the bot. */
import { hexToBytes } from '@noble/hashes/utils.js';
import { InMemoryNonceStore, SessionKeyRing, type NonceStore } from '@bsh/identity';
import { createMintClient } from '@bsh/degent-mint-sdk';
import type { Bot } from 'grammy';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import { GateService } from './application/gate-service.js';
import type { Logger } from './application/logger.js';
import type { GateConfig } from './config.js';
import { createGateBot, GrammyTelegramApi } from './adapters/grammy-telegram.js';
import { MemoryHolderRegistry } from './adapters/memory-holder-registry.js';
import { MemoryMemberStore } from './adapters/memory-member-store.js';
import { MemoryTelegramApi } from './adapters/memory-telegram.js';
import { MintHolderRegistry } from './adapters/mint-holder-registry.js';
import { openGateDatabase, SqliteMemberStore, SqliteNonceStore } from './adapters/sqlite-stores.js';
import type { HolderRegistry } from './ports/holder-registry.js';
import type { MemberStore } from './ports/member-store.js';
import type { TelegramApi } from './ports/telegram-api.js';

/** Regtest-only session key: config refuses a missing SESSION_KEY anywhere else. */
export const REGTEST_DEV_SESSION_KEY = '33'.repeat(32);

export interface Runtime {
  service: GateService;
  app: Hono;
  bot: Bot | null;
  close(): void;
}

export function buildRuntime(cfg: GateConfig, log: Logger): Runtime {
  let members: MemberStore;
  let nonces: NonceStore;
  let close = () => {};
  if (cfg.databasePath) {
    const db = openGateDatabase(cfg.databasePath);
    members = new SqliteMemberStore(db);
    nonces = new SqliteNonceStore(db);
    close = () => db.close();
  } else {
    log.warn('DATABASE_PATH unset: in-memory stores (regtest only, nothing persisted)');
    members = new MemoryMemberStore();
    nonces = new InMemoryNonceStore();
  }

  const holders: HolderRegistry = cfg.mintApiUrl
    ? new MintHolderRegistry(createMintClient({ baseUrl: cfg.mintApiUrl }), { cacheTtlMs: cfg.holderCacheMs })
    : new MemoryHolderRegistry();
  if (!cfg.mintApiUrl) log.warn('MINT_API_URL unset: in-memory holder registry (regtest only; nobody holds anything)');

  let service!: GateService;
  let bot: Bot | null = null;
  let telegram: TelegramApi;
  if (cfg.botToken) {
    bot = createGateBot(cfg.botToken, () => service, log);
    telegram = new GrammyTelegramApi(bot.api);
  } else {
    log.warn('TELEGRAM_GATE_BOT_TOKEN unset: in-memory Telegram adapter (regtest only; nothing is sent)');
    telegram = new MemoryTelegramApi();
  }

  const sessions = new SessionKeyRing({ kid: cfg.sessionKid, secretKey: hexToBytes(cfg.sessionKey ?? REGTEST_DEV_SESSION_KEY) });
  service = new GateService({ settings: cfg.settings, members, holders, telegram, nonces, sessions, log });
  const origin = cfg.settings.webBaseUrl ? new URL(cfg.settings.webBaseUrl).origin : '';
  const app = createApp({
    service,
    corsOrigins: origin ? [origin] : [],
    rateLimit: { windowMs: 60_000, max: cfg.rateLimitPerMinute },
    trustProxy: cfg.trustProxy,
    log,
  });
  return { service, app, bot, close };
}
