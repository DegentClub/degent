/** Process entry point: `pnpm --filter @bsh/blockspace-certify start` (env: env.schema.json). */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { CertifyService } from './application/certify-service.js';
import { FakeOrd } from './adapters/fake-ord.js';
import { HttpOrd } from './adapters/http-ord.js';
import { InMemoryAttestationSigner } from './adapters/memory-signer.js';
import { MemorySnapshotStore } from './adapters/memory-store.js';
import { ConfigError, loadConfig } from './config.js';
import { systemClock } from './ports/clock.js';

const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), service: 'blockspace-certify', msg, ...fields }));

function main(): void {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
  const ord = cfg.ord.kind === 'http' ? new HttpOrd({ baseUrl: cfg.ord.url, timeoutMs: cfg.ord.timeoutMs, childrenPath: cfg.ord.childrenPath }) : new FakeOrd();
  const signer = cfg.signingKeyHex ? InMemoryAttestationSigner.fromHex(cfg.signingKeyHex) : InMemoryAttestationSigner.random();
  if (!cfg.signingKeyHex) log('WARNING: ephemeral signing key (dev mode); attestations will not verify after restart', { keyId: signer.keyId });
  const service = new CertifyService({
    ord,
    signer,
    store: new MemorySnapshotStore(),
    clock: systemClock,
    collections: cfg.collections,
    concurrency: cfg.concurrency,
  });
  const app = createApp({ service, ord, clock: systemClock, adminToken: cfg.adminToken, log });
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) =>
    log('listening', { port: info.port, host: cfg.host, keyId: signer.keyId, collections: cfg.collections.map((c) => c.slug) }),
  );
}

main();
