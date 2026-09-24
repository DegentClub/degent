/** Composition root: config -> adapters -> service -> app. Tests build the same graph with fakes. */
import type { Hono } from 'hono';
import { createApp } from './app.js';
import { ClaudeVisionReview } from './adapters/claude-vision-review.js';
import { FsContentStore, MemoryContentStore, type ContentStore } from './adapters/content-store.js';
import { MemoryStateStore, SqliteStateStore, type StateStore } from './adapters/state-store.js';
import { AtelierService } from './application/atelier-service.js';
import type { Logger } from './application/logger.js';
import type { AtelierConfig } from './config.js';
import { FakeImageProvider } from './providers/fake.js';
import { HttpImageProvider } from './providers/http.js';
import type { ImageProvider } from './providers/image-provider.js';
import { OpenAiImageProvider } from './providers/openai.js';
import { CompositeArtReview, RulesArtReview, type ArtReview } from './review.js';

export interface Runtime {
  app: Hono;
  service: AtelierService;
  provider: ImageProvider;
  state: StateStore;
  content: ContentStore;
  close(): void;
}

export function buildProvider(cfg: AtelierConfig): ImageProvider {
  if (cfg.mode === 'openai' && cfg.openai)
    return new OpenAiImageProvider({ apiKey: cfg.openai.apiKey, model: cfg.openai.model, fallbackModel: cfg.openai.fallbackModel, quality: cfg.openai.quality, ...(cfg.openai.costCentsPerImage === null ? {} : { costCentsPerImage: cfg.openai.costCentsPerImage }) });
  if (cfg.mode === 'http' && cfg.http)
    return new HttpImageProvider({ url: cfg.http.url, apiKey: cfg.http.apiKey, style: cfg.http.style, authHeader: cfg.http.authHeader, authScheme: cfg.http.authScheme, costCentsPerImage: cfg.http.costCentsPerImage });
  return new FakeImageProvider();
}

export function buildRuntime(cfg: AtelierConfig, log: Logger): Runtime {
  const provider = buildProvider(cfg);
  const state: StateStore = cfg.databasePath ? new SqliteStateStore(cfg.databasePath) : new MemoryStateStore();
  const content: ContentStore = cfg.contentDir ? new FsContentStore(cfg.contentDir) : new MemoryContentStore();
  const vision: ArtReview | null = ClaudeVisionReview.fromEnv(cfg.visionReviewApiKey);
  const rules = new RulesArtReview();
  const service = new AtelierService({
    provider,
    candidateReview: vision,
    outputReview: vision ? new CompositeArtReview([rules, vision]) : rules,
    content,
    state,
    quotas: cfg.quotas,
    log,
    concurrency: cfg.workerConcurrency,
  });
  const app = createApp({
    service,
    corsOrigins: cfg.corsOrigins,
    trustedProxies: cfg.trustedProxies,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    sessionRateLimitPerMinute: cfg.sessionRateLimitPerMinute,
    publicBaseUrl: cfg.publicBaseUrl,
    log,
  });
  return { app, service, provider, state, content, close: () => state.close() };
}
