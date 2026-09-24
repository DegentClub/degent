/**
 * `pnpm --filter @bsh/degent-x-bot start`: one pass over the Register's /v1/stats -> milestone and weekly drafts,
 * printed with their tier and decision, then any human-approved drafts are posted (only with POSTING_ENABLED=true).
 * The delivered-event feed is `DraftPipeline.attach(bus)` in the process that owns the platform bus connection.
 */
import { createMintClient } from '@bsh/degent-mint-sdk';
import { HttpXClient } from './adapters/http-x-client.js';
import { MemoryDraftStore } from './adapters/memory-draft-store.js';
import { MemoryXClient } from './adapters/memory-x-client.js';
import { jsonLogger } from './application/logger.js';
import { Publisher } from './application/publisher.js';
import { ConfigError, loadConfig } from './config.js';
import { DraftPipeline } from './drafts/pipeline.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const x = cfg.xAccessToken ? new HttpXClient({ accessToken: cfg.xAccessToken }) : new MemoryXClient();
  const store = new MemoryDraftStore();
  const publisher = new Publisher({ store, x, settings: cfg.publisher, log });
  const pipeline = new DraftPipeline({ register: createMintClient({ baseUrl: cfg.mintApiUrl }), publisher, milestoneEvery: cfg.milestoneEvery, log });
  const results = await pipeline.fromStats();
  for (const r of results) log.info('draft', { kind: r.draft.kind, tier: r.draft.tier, status: r.draft.status, posted: r.posted, text: r.draft.text });
  log.info('done', { drafts: results.length, reviewQueueEnabled: cfg.publisher.reviewQueueEnabled, postingEnabled: cfg.publisher.postingEnabled });
}

main().catch((e) => {
  if (e instanceof ConfigError) log.error('configuration error', { problems: e.problems });
  else log.error('fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
