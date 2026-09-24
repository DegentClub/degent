/**
 * Composition root: builds real adapters from StudioConfig. main.ts calls this; tests call it with a
 * regtest config to prove the wiring is sound. In-memory defaults everywhere on regtest.
 */
import { readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils.js';
import { InMemoryApiKeyStore, generateApiKey, type ApiKeyRecord } from '@bsh/edge';
import { InMemoryNonceStore, SessionKeyRing, generateSigningKey, type NonceStore, type SigningKey, type VerificationKey } from '@bsh/identity';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import type { StudioConfig } from './config.js';
import { StudioService } from './application/studio-service.js';
import { jsonLogger, type Logger } from './application/logger.js';
import { FsContentStore, MemoryContentStore } from './adapters/content-stores.js';
import { MemoryArtistStore, MemoryArtworkStore, MemoryRoyaltyStore } from './adapters/memory-stores.js';
import { SqliteStudioStore } from './adapters/sqlite-store.js';
import { CompositeArtReview, HumanGateReview, RulesArtReview } from './adapters/rules-art-review.js';
import { ClaudeVisionReview } from './adapters/claude-vision-review.js';
import { MemoryEventBus, systemClock } from './adapters/system.js';
import type { ArtReview } from './ports/art-review.js';
import type { ArtistStore } from './ports/artist-store.js';
import type { ArtworkStore } from './ports/artwork-store.js';
import type { RoyaltyStore } from './ports/royalty-store.js';

export interface Runtime {
  app: Hono;
  service: StudioService;
  events: MemoryEventBus;
  keys: SessionKeyRing;
  apiKeys: InMemoryApiKeyStore;
  /** Dev-only API keys generated on regtest when none are configured (shown once at startup). */
  devApiKeys: Array<{ id: string; key: string; scopes: string[] }>;
  close(): void;
}

export function buildRuntime(cfg: StudioConfig, log: Logger = jsonLogger()): Runtime {
  const net = cfg.settings.network;
  const dev = net === 'regtest';

  let artists: ArtistStore;
  let artworks: ArtworkStore;
  let royalties: RoyaltyStore;
  let nonces: NonceStore;
  let close = () => {};
  if (cfg.databasePath) {
    const sqlite = new SqliteStudioStore(cfg.databasePath);
    artists = sqlite.artists;
    artworks = sqlite.artworks;
    royalties = sqlite.royalties;
    nonces = sqlite.nonces;
    close = () => sqlite.close();
  } else {
    artists = new MemoryArtistStore();
    artworks = new MemoryArtworkStore();
    royalties = new MemoryRoyaltyStore();
    nonces = new InMemoryNonceStore();
  }
  const content = cfg.contentDir ? new FsContentStore(cfg.contentDir) : new MemoryContentStore();

  let active: SigningKey;
  if (cfg.sessionSigningKey) active = { kid: cfg.sessionKid, secretKey: hexToBytes(cfg.sessionSigningKey) };
  else if (dev) {
    active = generateSigningKey(cfg.sessionKid);
    log.warn('using an ephemeral session signing key (regtest dev only): sessions do not survive a restart', {});
  } else throw new Error('no SESSION_SIGNING_KEY configured');
  const previous: VerificationKey[] = cfg.sessionPreviousKeys.map((k) => ({ kid: k.kid, publicKey: hexToBytes(k.publicKeyHex) }));
  const keys = new SessionKeyRing(active, previous);

  const apiKeys = new InMemoryApiKeyStore();
  const devApiKeys: Runtime['devApiKeys'] = [];
  if (cfg.apiKeys.length > 0) for (const k of cfg.apiKeys) apiKeys.add(k);
  else if (dev) {
    for (const [id, scopes] of [
      ['dev-reviewer', ['studio:review']],
      ['dev-mint', ['studio:internal']],
    ] as const) {
      const g = generateApiKey('test');
      const record: ApiKeyRecord = { id, hash: g.hash, env: 'test', scopes: [...scopes] };
      apiKeys.add(record);
      devApiKeys.push({ id, key: g.key, scopes: [...scopes] });
    }
    log.warn('generated dev API keys (regtest dev only); they are printed once below', { ids: devApiKeys.map((k) => k.id) });
  } else log.warn('no API_KEYS configured: house review and royalty endpoints cannot be used', {});

  const guidelines = cfg.visionReviewGuidelinesFile ? readFileSync(cfg.visionReviewGuidelinesFile, 'utf8') : undefined;
  // No pure-JS JPEG downscaler is wired (jpeg-js is not in the workspace); oversized images wait for a human.
  const vision: ArtReview = ClaudeVisionReview.fromEnv(cfg.visionReviewApiKey, guidelines) ?? new HumanGateReview();
  if (vision instanceof HumanGateReview) log.info('vision review disabled (no VISION_REVIEW_API_KEY): every rule-compliant submission needs a house reviewer', {});
  const review = new CompositeArtReview([new RulesArtReview(cfg.settings.rules), vision]);

  const events = new MemoryEventBus();
  const service = new StudioService({ settings: cfg.settings, artists, artworks, royalties, nonces, content, review, events, keys, clock: systemClock });
  const app = createApp({
    service,
    apiKeyStore: apiKeys,
    apiKeyEnvironment: cfg.apiKeyEnvironment,
    clock: systemClock,
    corsOrigins: cfg.corsOrigins,
    trustedProxies: cfg.trustedProxies,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    log,
  });
  return { app, service, events, keys, apiKeys, devApiKeys, close };
}
