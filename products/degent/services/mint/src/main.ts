/** Entry point: `pnpm --filter @bsh/degent-mint dev|start`. */
import { serve } from '@hono/node-server';
import { loadConfig, ConfigError } from './config.js';
import { buildRuntime, initialiseParent } from './wiring.js';
import { jsonLogger } from './application/logger.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const rt = buildRuntime(cfg, log);
  await initialiseParent(rt, cfg, log).catch((e) => log.error('parent initialisation failed', { error: String(e) }));
  const server = serve({ fetch: rt.app.fetch, port: cfg.port, hostname: cfg.host });
  log.info('degent-mint listening', { network: cfg.settings.network, host: cfg.host, port: cfg.port, collectionAddress: rt.signer.collectionAddress() });
  const stop = new AbortController();
  const worker = rt.worker.run(cfg.workerIntervalMs, stop.signal);
  const shutdown = (sig: string) => {
    log.info('shutting down', { signal: sig });
    stop.abort();
    server.close();
    void worker.finally(() => {
      rt.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  if (e instanceof ConfigError) log.error('configuration error', { problems: e.problems });
  else log.error('fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
